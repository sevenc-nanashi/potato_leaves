import fs from "fs";
import dotenv from "dotenv";
import axios from "axios";
import { open } from "sqlite";
import sqlite3 from "sqlite3";
import FormData from "form-data";
import { gunzip as gunzipCb, gzip as gzipCb } from "zlib";
import { promisify } from "util";
import { LevelData, LevelDataEntity, hash } from "@sonolus/core";
import axiosRetry from "axios-retry";
import https from "https";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

dotenv.config({ path: ".env" });
dotenv.config({ path: "../.env" });

const gunzip = promisify(gunzipCb);
const gzip = promisify(gzipCb);

axiosRetry(axios, { retries: 3, retryDelay: () => 1000 });

let db: Awaited<ReturnType<typeof open>>;

const s3Client = new S3Client({
  endpoint: process.env.S3_ENDPOINT!,
  credentials: {
    accessKeyId: process.env.S3_USER!,
    secretAccessKey: process.env.S3_PASSWORD!,
  },
  region: process.env.S3_REGION!,
});

const queue: ({ name: string; data: Buffer } | false)[] = [];

const httpsAgent = new https.Agent({ keepAlive: true });

const sender = async () => {
  let i = 0;
  while (true) {
    try {
      const queueItem = queue.shift();
      if (queueItem === undefined) {
        console.log("Sender: Waiting");
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      } else if (queueItem === false) {
        break;
      }

      const { name, data } = queueItem;

      console.log(`Sender: Sending ${name}`);
      const sha = hash(data);

      const result = await s3Client.send(
        new PutObjectCommand({
          Bucket: process.env.S3_BUCKET,
          Key: sha,
          Body: data,
        })
      );

      const fileUrl = process.env.S3_PUBLIC_URL + sha;

      await db.run(
        "DELETE FROM files WHERE name = ? AND type = ?",
        name,
        "NewLevelData"
      );
      await db.run(
        "INSERT INTO files (name, type, hash, url) VALUES (?, ?, ?, ?)",
        name,
        "NewLevelData",
        sha,
        fileUrl
      );
      console.log(`Sender: [${i}] ${name} (${sha}) -> ${fileUrl}`);
    } catch (e) {
      console.error(e);
    }
  }
};

const valueArrayToKeyedObject = (values: number[]) => {
  return [
    {
      name: "#BEAT",
      value: values[0],
    },
    {
      name: "lane",
      value: values[1],
    },
    {
      name: "size",
      value: values[2],
    },
  ];
};
const convertFlick = (before: number) => {
  if (before === 0) {
    return -1;
  } else if (before === 1) {
    return 1;
  } else {
    return 0;
  }
};
const convertEase = (before: number) => {
  if (before === 0) {
    return 1;
  } else if (before === 1) {
    return -1;
  } else {
    return 0;
  }
};

const converter = async () => {
  const levelDataList = await db.all(
    "SELECT * FROM files WHERE type = 'LevelData'"
  );
  const existingLevelDataList = await db
    .all("SELECT * FROM files WHERE type = 'NewLevelData'")
    .then((rows) => new Set(rows.map((row) => row.name)));
  for (const [index, levelData] of levelDataList.entries()) {
    if (existingLevelDataList.has(levelData.name)) {
      continue;
    }
    while (true) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (queue.length < 10) {
        break;
      }
    }

    console.log(
      `Converter: started ${levelData.name} (${index + 1}/${
        levelDataList.length
      })`
    );
    const levelDataResp = await axios.get(levelData.url, {
      responseType: "arraybuffer",
    });
    const levelDataBuffer = levelDataResp.data;
    try {
      const levelDataJson: {
        entities: {
          archetype: number;
          data: { values: number[] };
        }[];
      } = JSON.parse((await gunzip(levelDataBuffer)).toString());
      console.log(
        `Converter: loaded, ${levelDataJson.entities.length} entities`
      );
      const newLevelDataJson: LevelData = {
        bgmOffset: 0,
        entities: [
          {
            archetype: "Initialization",
            data: [],
          },
          {
            archetype: "InputManager",
            data: [],
          },
          {
            archetype: "Stage",
            data: [],
          },
          {
            archetype: "#BPM_CHANGE",
            data: [
              {
                name: "#BEAT",
                value: 0,
              },
              {
                name: "#BPM",
                value: 60,
              },
            ],
          },
        ],
      };
      const usedEntities = new Set<number | string>();
      const generatedHiddenTicks: Record<string, string> = {};
      for (const [index, entity] of Object.entries(levelDataJson.entities)) {
        let data: LevelDataEntity;
        switch (entity.archetype) {
          case 0:
          case 1:
          case 2:
            continue;
          case 3:
          case 10:
            data = {
              archetype:
                entity.archetype === 3 ? "NormalTapNote" : "CriticalTapNote",
              data: [...valueArrayToKeyedObject(entity.data.values)],
            };
            break;
          case 4:
          case 11:
            data = {
              archetype:
                entity.archetype === 4
                  ? "NormalFlickNote"
                  : "CriticalFlickNote",
              data: [
                ...valueArrayToKeyedObject(entity.data.values),
                {
                  name: "direction",
                  value: convertFlick(entity.data.values[3]),
                },
              ],
            };
            break;
          case 5:
          case 12:
            data = {
              archetype:
                entity.archetype === 5
                  ? "NormalSlideStartNote"
                  : "CriticalSlideStartNote",
              data: [...valueArrayToKeyedObject(entity.data.values)],
            };
            break;
          case 6:
          case 13:
            data = {
              archetype:
                entity.archetype === 6
                  ? "NormalSlideTickNote"
                  : "CriticalSlideTickNote",
              data: [...valueArrayToKeyedObject(entity.data.values)],
            };
            break;
          case 7:
          case 14:
            data = {
              archetype:
                entity.archetype === 7
                  ? "NormalSlideEndNote"
                  : "CriticalSlideEndNote",
              data: [...valueArrayToKeyedObject(entity.data.values)],
            };
            break;
          case 8:
          case 15:
            data = {
              archetype:
                entity.archetype === 8
                  ? "NormalSlideEndFlickNote"
                  : "CriticalSlideEndFlickNote",
              data: [
                ...valueArrayToKeyedObject(entity.data.values),
                {
                  name: "direction",
                  value: convertFlick(entity.data.values[3]),
                },
              ],
            };
            break;
          case 9:
          case 16:
            const slideStart = levelDataJson.entities.findIndex((e, i) => {
              return (
                !usedEntities.has(i) &&
                [5, 11].includes(e.archetype) &&
                e.data.values[0] === entity.data.values[0] &&
                e.data.values[1] === entity.data.values[1] &&
                e.data.values[2] === entity.data.values[2]
              );
            });
            let startRef: string;
            if (slideStart === -1) {
              const generatedSlideStart =
                generatedHiddenTicks[
                  `${entity.data.values[0]}-${entity.data.values[1]}-${entity.data.values[2]}`
                ];
              if (generatedSlideStart) {
                startRef = generatedSlideStart;
              } else {
                newLevelDataJson.entities.push({
                  archetype: "HiddenSlideStartNote",
                  data: [...valueArrayToKeyedObject(entity.data.values)],
                  name: `s-${index}`,
                });
                generatedHiddenTicks[
                  `${entity.data.values[0]}-${entity.data.values[1]}-${entity.data.values[2]}`
                ] = `s-${index}`;
                startRef = `s-${index}`;
              }
            } else {
              startRef = slideStart.toString();
              usedEntities.add(slideStart);
            }
            const slideEnd = levelDataJson.entities.findIndex((e, i) => {
              return (
                !usedEntities.has(i) &&
                [7, 8, 13, 14].includes(e.archetype) &&
                e.data.values[0] === entity.data.values[3] &&
                e.data.values[1] === entity.data.values[4] &&
                e.data.values[2] === entity.data.values[5]
              );
            });
            let endRef: string;
            if (slideEnd === -1) {
              newLevelDataJson.entities.push({
                archetype: "HiddenSlideTickNote",
                data: [
                  ...valueArrayToKeyedObject([
                    entity.data.values[3],
                    entity.data.values[4],
                    entity.data.values[5],
                  ]),
                ],
                name: `e-${index}`,
              });
              generatedHiddenTicks[
                `${entity.data.values[3]}-${entity.data.values[4]}-${entity.data.values[5]}`
              ] = `e-${index}`;
              endRef = `e-${index}`;
            } else {
              endRef = slideEnd.toString();
              usedEntities.add(slideEnd);
            }
            data = {
              archetype:
                entity.archetype === 9
                  ? "NormalSlideConnector"
                  : "CriticalSlideConnector",
              data: [
                {
                  name: "start",
                  ref: entity.data.values[7]?.toString() || startRef,
                },
                {
                  name: "head",
                  ref: startRef,
                },
                {
                  name: "tail",
                  ref: endRef,
                },
                {
                  name: "ease",
                  value: convertEase(entity.data.values[6]),
                },
              ],
            };
            break;
          case 17:
            continue;
          default:
            throw new Error(`Unknown archetype: ${entity.archetype}`);
        }
        data.name = index.toString();
        newLevelDataJson.entities.push(data);
      }
      const slideEntities = Object.entries(levelDataJson.entities).filter(
        ([, e]) => [9, 16].includes(e.archetype)
      );
      console.log("Converter: Processing hidden tick entities");
      for (const entity of levelDataJson.entities) {
        if (entity.archetype !== 17) continue;
        const [entityTime, entityLane, entitySize] = entity.data.values;
        const nearSlides = slideEntities.flatMap(([i, e]) => {
          const [
            startTime,
            startLane,
            startSize,
            endTime,
            endLane,
            endSize,
            easeInt,
          ] = e.data.values;
          if (
            !(
              startTime <= entity.data.values[0] &&
              entity.data.values[0] <= endTime
            )
          )
            return [];
          const easeType = (["easeIn", "easeOut", "linear"] as const).at(
            easeInt
          );
          if (!easeType) throw new Error(`Unknown ease type: ${easeInt}`);
          const progress = ease(
            unlerp(startTime, endTime, entityTime),
            easeType
          );
          const lane = lerp(startLane, endLane, progress);
          const size = lerp(startSize, endSize, progress);

          return [
            {
              lane,
              size,
              index: i,
            },
          ];
        });
        if (nearSlides.length === 0) {
          console.log("No near slides");
          continue;
        }
        nearSlides.sort((a, b) => {
          return (
            Math.abs(a.lane - entityLane) +
            Math.abs(a.size - entitySize) -
            (Math.abs(b.lane - entityLane) + Math.abs(b.size - entitySize))
          );
        });
        const nearSlide = nearSlides[0];
        newLevelDataJson.entities.push({
          archetype: "IgnoredSlideTickNote",
          data: [
            {
              name: "#BEAT",
              value: entityTime,
            },
            {
              name: "attach",
              ref: nearSlide.index.toString(),
            },
          ],
        });
      }
      const touchableNotes = newLevelDataJson.entities.filter((e) =>
        [
          "NormalTapNote",
          "NormalFlickNote",
          "NormalSlideStartNote",
          "NormalSlideEndNote",
          "NormalSlideEndFlickNote",
          "CriticalTapNote",
          "CriticalFlickNote",
          "CriticalSlideStartNote",
          "CriticalSlideEndNote",
          "CriticalSlideEndFlickNote",
        ].includes(e.archetype)
      );
      if (touchableNotes.length > 100000) {
        console.log(
          `Converter: Too many touchable notes (${touchableNotes.length}), skipping sim line generation`
        );
      } else {
        console.log(
          `Converter: Processing sim line, ${touchableNotes.length} entities`
        );
        const combinations = new Set<string>();
        for (const entity of touchableNotes) {
          const sameTimeEntities = touchableNotes.filter(
            (e) =>
              "value" in e.data[0] &&
              "value" in entity.data[0] &&
              e.data[0].value === entity.data[0].value &&
              e.name !== entity.name &&
              !combinations.has(`${e.name}:${entity.name}`)
          );
          for (const otherEntity of sameTimeEntities) {
            if (!entity.name || !otherEntity.name) throw new Error("No ref");
            combinations.add(`${entity.name}:${otherEntity.name}`);
            combinations.add(`${otherEntity.name}:${entity.name}`);
            newLevelDataJson.entities.push({
              archetype: "SimLine",
              data: [
                {
                  name: "a",
                  ref: entity.name,
                },
                {
                  name: "b",
                  ref: otherEntity.name,
                },
              ],
            });
          }
        }
      }
      console.log("Converter: Compressing");
      const newLevelData = await gzip(JSON.stringify(newLevelDataJson));

      console.log(`Converter: Done`);
      queue.push({
        name: levelData.name,
        data: newLevelData,
      });
    } catch (e) {
      console.error(e);
    }
  }
  queue.push(false);
};

const lerp = (a: number, b: number, t: number) => {
  return a + (b - a) * t;
};
const unlerp = (a: number, b: number, t: number) => {
  return (t - a) / (b - a);
};
const ease = (t: number, ease: "linear" | "easeIn" | "easeOut") => {
  switch (ease) {
    case "linear":
      return t;
    case "easeIn":
      return t * t;
    case "easeOut":
      return 1 - (1 - t) * (1 - t);
  }
};
(async () => {
  db = await open({
    filename: "./archive.db",
    driver: sqlite3.Database,
  });

  sender();
  converter();
})();

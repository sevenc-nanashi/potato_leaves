import fs from "fs/promises";
import dotenv from "dotenv";
import axios from "axios";
import { open } from "sqlite";
import sqlite3 from "sqlite3";
import FormData from "form-data";
import { gunzip as gunzipCb, gzip as gzipCb } from "zlib";
import { promisify } from "util";
import { LevelData, LevelDataEntity, hash } from "sonolus-core";
import axiosRetry from "axios-retry";
import https from "https";

const gunzip = promisify(gunzipCb);
const gzip = promisify(gzipCb);

axiosRetry(axios, { retries: 3, retryDelay: () => 1000 });

let db: Awaited<ReturnType<typeof open>>;
dotenv.config();

const webhookUrl = process.env.WEBHOOK_URL;
if (!webhookUrl) {
  throw new Error("WEBHOOK_URL is not defined");
}

const queue: ({ name: string; data: Buffer } | false)[] = [];

const httpsAgent = new https.Agent({ keepAlive: true });

const sender = async () => {
  let lastSendTime = Date.now();
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

      await db.run(
        "DELETE FROM files WHERE name = ? AND type = ?",
        name,
        "NewLevelData"
      );
      if (Date.now() - lastSendTime < 1100) {
        console.log("Sender: Waiting for rate limit");
        await new Promise((resolve) =>
          setTimeout(resolve, 1100 - (Date.now() - lastSendTime))
        );
      }
      lastSendTime = Date.now();
      let fileUrl: string;
      while (true) {
        console.log(`Sender: Sending request (length: ${data.length})`);
        try {
          const formData = new FormData();

          formData.append("content", sha);
          formData.append("files[0]", data, {
            filename: sha,
          });

          const fileResp = await axios.post(webhookUrl + "?wait=1", formData, {
            validateStatus: (code) => code === 200 || code === 429,
            timeout: 5000,
            httpsAgent,
          });
          if (fileResp.status === 429) {
            console.log(
              `Sender: Rate limited for ${fileResp.data.retry_after}s`
            );
            await new Promise((resolve) =>
              setTimeout(resolve, fileResp.data.retry_after * 1000)
            );
            continue;
          }
          fileUrl = fileResp.data.attachments[0].url;
          break;
        } catch (e) {
          console.log(`Sender: Request failed, ${e}`);
          httpsAgent.destroy();
        }
      }
      await db.run(
        "INSERT INTO files (name, type, hash, url) VALUES (?, ?, ?, ?)",
        name,
        "NewLevelData",
        sha,
        fileUrl
      );
      console.log(`Sender: ${name} (${sha}) -> ${fileUrl}`);
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
  for (const levelData of levelDataList) {
    if (existingLevelDataList.has(levelData.name)) {
      continue;
    }
    while (true) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (queue.length < 10) {
        break;
      }
    }

    console.log(`Converter: started ${levelData.name}`);
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
              data: [...valueArrayToKeyedObject(entity.data.values)],
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
                  archetype: "IgnoredSlideTickNote",
                  data: [...valueArrayToKeyedObject(entity.data.values)],
                  ref: `s-${index}`,
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
                archetype: "IgnoredSlideTickNote",
                data: [
                  ...valueArrayToKeyedObject([
                    entity.data.values[3],
                    entity.data.values[4],
                    entity.data.values[5],
                  ]),
                ],
                ref: `e-${index}`,
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
        data.ref = index.toString();
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
          archetype: "HiddenSlideTickNote",
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
              e.ref !== entity.ref &&
              !combinations.has(`${e.ref}:${entity.ref}`)
          );
          for (const otherEntity of sameTimeEntities) {
            if (!entity.ref || !otherEntity.ref) throw new Error("No ref");
            combinations.add(`${entity.ref}:${otherEntity.ref}`);
            combinations.add(`${otherEntity.ref}:${entity.ref}`);
            newLevelDataJson.entities.push({
              archetype: "SimLine",
              data: [
                {
                  name: "a",
                  ref: entity.ref,
                },
                {
                  name: "b",
                  ref: otherEntity.ref,
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

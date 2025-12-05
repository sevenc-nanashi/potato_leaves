import express from "express";
import { open } from "sqlite";
import sqlite3 from "sqlite3";
import chalk from "chalk";
import {
  EngineItem,
  ServerItemDetails,
  ServerItemInfo,
  ServerItemList,
  LevelItem,
  ServerInfo,
  hash,
  ServerLevelResultInfo,
} from "@sonolus/core";
import axios from "axios";
import fs from "fs";

let db: Awaited<ReturnType<typeof open>>;
let bgDataHash: string;

const app = express();

type Level = {
  name: string;
  title: string;
  artists: string;
  author: string;
  rating: number;
  description: string;
};
type File = {
  name: string;
  type: string;
  hash: string;
  url: string;
};
type FileSet = {
  cover: File;
  bgm: File;
  data: File;
  background: File;
};

let engine: EngineItem;

const getFiles = async (files: File[]): Promise<FileSet> => {
  const cover = files.find((file) => file.type === "LevelCover");
  const bgm = files.find((file) => file.type === "LevelBgm");
  const data = files.find((file) => file.type === "NewLevelData");
  const background = files.find((file) => file.type === "BackgroundImage");
  if (!cover || !bgm || !data || !background) {
    const missing = Object.entries({ cover, bgm, data, background })
      .filter(([, file]) => !file)
      .map(([type]) => type);
    throw new Error(`Missing files: ${missing.join(", ")}`);
  }

  return { cover, bgm, data, background };
};

const toLevelItem = (level: Level, files: FileSet): LevelItem => {
  const { bgm, cover, data, background } = files;
  return {
    name: level.name.replace("frpt-", "ptlv-"),
    title: level.title,
    artists: level.artists,
    author: level.author,
    source: "https://ptlv.sevenc7c.com",
    tags: [],
    bgm: {
      hash: bgm.hash,
      url: bgm.url,
    },
    cover: {
      hash: cover.hash,
      url: cover.url,
    },
    data: {
      hash: data.hash,
      url: data.url,
    },
    useBackground: {
      useDefault: false,
      item: {
        name: level.name.replace("frpt-", "ptlv-bg-"),
        version: 2,
        title: level.title,
        subtitle: level.artists,
        author: level.author,
        thumbnail: engine.background.thumbnail,
        data: {
          hash: bgDataHash,
          url: `/assets/bgData.json.gz`,
        },
        tags: [],
        image: {
          hash: background.hash,
          url: background.url,
        },
        configuration: engine.background.configuration,
      },
    },
    engine,
    rating: level.rating,
    useEffect: {
      useDefault: true,
    },
    useParticle: {
      useDefault: true,
    },
    useSkin: {
      useDefault: true,
    },
    version: 1,
  };
};

app.use((req, res, next) => {
  console.log(chalk.blue("i) ") + `${chalk.green(req.method)} ${req.url}`);
  res.header("Sonolus-Version", "1.0.2");
  next();
});

app.get("/", (req, res) => {
  res.redirect(`https://open.sonolus.com/${req.hostname}`);
});
app.get("/levels/:name", (req, res) => {
  res.redirect(
    `https://open.sonolus.com/${req.hostname}/levels/${req.params.name}`,
  );
});

app.get("/sonolus/info", async (req, res) => {
  res.send({
    title: "Potato Leaves",
    configuration: { options: [] },
    buttons: [
      {
        type: "level",
      },
    ],
  } satisfies ServerInfo);
});
app.get("/sonolus/levels/info", async (req, res) => {
  const levels: Level[] = await db.all(
    "SELECT * FROM levels ORDER BY random() LIMIT 5",
  );
  const files: File[] = await db.all(
    `SELECT * FROM files WHERE name IN (${levels.map(() => "?").join(", ")})`,
    levels.map((level) => level.name),
  );
  const levelItems = await Promise.all(
    levels.map(async (level) => {
      const levelFiles = files.filter((file) => file.name === level.name);
      const fileSet = await getFiles(levelFiles);
      return toLevelItem(level, fileSet);
    }),
  );

  res.send({
    searches: [],
    sections: [
      {
        itemType: "level",
        title: "#RANDOM",
        items: levelItems,
      },
    ],
  } satisfies ServerItemInfo);
});

app.get("/sonolus/levels/list", async (req, res) => {
  if (!req.query.page) {
    res.status(400).send({
      error: "Missing page",
    });
    return;
  }
  if (
    Array.isArray(req.query.page) ||
    isNaN(+req.query.page) ||
    (!!req.query.keywords && typeof req.query.keywords !== "string")
  ) {
    res.status(400).send({
      error: "Invalid request",
    });
    return;
  }
  const keywords =
    req.query.keywords?.split(" ").filter((keyword) => keyword.length > 0) ||
    [];

  const query = `WHERE ${
    keywords
      .map(
        () =>
          "(name LIKE ? OR lower(title) LIKE lower(?) OR lower(artists) LIKE lower(?) OR lower(author) LIKE lower(?))",
      )
      .join(" AND ") || "TRUE"
  }`;
  const queryParam = keywords
    .map((keyword) => `%${keyword}%`)
    .flatMap((keyword) => [keyword, keyword, keyword, keyword]);

  const levelCount = (await db
    .get(`SELECT COUNT(*) FROM levels ${query}`, ...queryParam)
    .then((row) => row["COUNT(*)"])) as number;

  const levels: Level[] = await db.all(
    `SELECT * FROM levels ${query} ORDER BY index_ DESC LIMIT 20 OFFSET ?`,
    ...queryParam,
    parseInt(req.query.page as string) * 20,
  );
  const files: File[] = await db.all(
    `SELECT * FROM files WHERE ${levels
      .map(() => `name = ? OR `)
      .join(" ")} FALSE`,
    ...[...levels.map((level) => level.name)],
  );

  res.send({
    pageCount: Math.ceil(levelCount / 20),
    searches: [],
    items: await Promise.all(
      levels.flatMap((level) => [
        getFiles(files.filter((file) => file.name === level.name))
          .then((files) => toLevelItem(level, files))
          .catch(() => null),
      ]),
    ).then((items) => items.filter((item) => item !== null) as LevelItem[]),
  } satisfies ServerItemList<LevelItem>);
});

app.get("/sonolus/levels/:name", async (req, res) => {
  const level: Level | undefined = await db.get(
    "SELECT * FROM levels WHERE name = ?",
    req.params.name.replace("ptlv-", "frpt-"),
  );
  if (!level) {
    res.status(404).send({
      error: "Level not found",
    });
    return;
  }
  const files: File[] = await db.all(
    "SELECT * FROM files WHERE name = ?",
    req.params.name.replace("ptlv-", "frpt-"),
  );
  const fileSet = await getFiles(files);
  res.send({
    item: toLevelItem(level, fileSet),
    description: level.description,
    sections: [],
    actions: [],
    hasCommunity: false,
    leaderboards: [],
  } satisfies ServerItemDetails<LevelItem>);
});

app.get("/sonolus/levels/result/info", async (req, res) => {
  res.send({
    submits: [],
  } satisfies ServerLevelResultInfo);
});

app.get("/assets/bgData.json.gz", async (req, res) => {
  res.sendFile("assets/bgData.json.gz", { root: process.cwd() });
});
(async () => {
  const port = process.env.PORT || 3000;
  bgDataHash = hash(await fs.promises.readFile("assets/bgData.json.gz"));
  db = await open({
    filename: "./archive.db",
    driver: sqlite3.Database,
  });
  const levelCount = await db
    .get("SELECT COUNT(*) FROM levels")
    .then((count) => count["COUNT(*)"]);
  await axios
    .get("https://cc.sevenc7c.com/sonolus/engines/list")
    .then((res) => {
      engine = JSON.parse(
        JSON.stringify(res.data.items[0]).replaceAll(
          '"/',
          '"https://cc.sevenc7c.com/',
        ),
      );
    });

  app.listen(port, async () => {
    console.log(chalk.magenta(`Potato Leaves: Started at port ${port}`));
    const files = await db.get("SELECT COUNT(*) FROM files");
    console.log(chalk.blue("i) ") + `Levels: ${levelCount}`);
    console.log(chalk.blue("i) ") + ` Files: ${files["COUNT(*)"]}`);
    console.log();
  });
})();

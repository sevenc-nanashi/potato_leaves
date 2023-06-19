import dotenv from "dotenv";
import axios from "axios";
import { open } from "sqlite";
import sqlite3 from "sqlite3";
import crypto from "crypto";
import FormData from "form-data";
import axiosRetry from "axios-retry";

axiosRetry(axios, { retries: 3 });

let db: Awaited<ReturnType<typeof open>>;
dotenv.config();

const webhookUrl = process.env.WEBHOOK_URL;
if (!webhookUrl) {
  throw new Error("WEBHOOK_URL is not defined");
}

const queue: (
  | [name: string, dest: { type: string; hash: string; url: string }]
  | false
)[] = [];

const sender = async () => {
  let lastSendTime = Date.now();
  while (true) {
    try {
      const queueItem = queue.shift();
      if (queueItem === undefined) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        continue;
      } else if (queueItem === false) {
        break;
      }

      const [name, item] = queueItem;

      let url: string;
      if (item.url.startsWith("http")) {
        url = item.url;
      } else {
        url = `https://fp.sevenc7c.com${item.url}`;
      }
      const baseResp = await axios.get(url, {
        responseType: "stream",
      });
      const formData = new FormData();
      let hash = item.hash;
      if (["LevelCover", "LevelBgm"].includes(item.type)) {
        formData.append("files[0]", baseResp.data, {
          filename: item.hash,
        });
        if (
          await db.get(
            "SELECT * FROM files WHERE name = ? AND type = ? AND hash = ?",
            name,
            item.type,
            hash
          )
        ) {
          continue;
        }
      } else {
        const hashObj = crypto.createHash("sha1");
        for await (const chunk of baseResp.data) {
          hashObj.update(chunk);
        }
        hash = hashObj.digest("hex");
        if (
          await db.get(
            "SELECT * FROM files WHERE name = ? AND type = ? AND hash = ?",
            name,
            item.type,
            hash
          )
        ) {
          continue;
        }
        formData.append(
          "files[0]",
          (await axios.get(url, { responseType: "arraybuffer" })).data,
          {
            filename: hash,
          }
        );
      }
      formData.append("content", hash);
      if (Date.now() - lastSendTime < 1000) {
        await new Promise((resolve) =>
          setTimeout(resolve, 1000 - (Date.now() - lastSendTime))
        );
      }
      const fileResp = await axios.post(webhookUrl + "?wait=1", formData);
      const fileUrl = fileResp.data.attachments[0].url;
      await db.run(
        "DELETE FROM files WHERE name = ? AND type = ?",
        name,
        item.type
      );
      await db.run(
        "INSERT INTO files (name, type, hash, url) VALUES (?, ?, ?, ?)",
        name,
        item.type,
        hash,
        fileUrl
      );
      console.log(`${name}:${item.type} (${hash}) -> ${fileUrl}`);
    } catch (e) {
      console.error(e);
    }
  }
};

const collector = async () => {
  let startTime = Date.now();
  const { data } = await axios.get(
    "https://fp.sevenc7c.com/sonolus/levels/list"
  );
  for (let pageNumber = 0; pageNumber < data.pageCount; pageNumber++) {
    console.log(`Page ${pageNumber + 1}/${data.pageCount}`);
    const { data: page } = await axios.get(
      `https://fp.sevenc7c.com/sonolus/levels/list?page=${pageNumber}`
    );
    let shouldExit = false;

    await Promise.all(
      page.items.map(
        async (
          {
            name: levelName,
            engine: { title: engineTitle },
          }: {
            name: string;
            engine: { title: string };
          },
          i: number
        ) => {
          if (engineTitle.includes("Converter")) {
            shouldExit = true;
            return;
          }
          const { data } = await axios.get(
            `https://fp.sevenc7c.com/sonolus/levels/${levelName}`
          );
          const level = data.item;
          queue.push([levelName, level.cover]);
          queue.push([levelName, level.bgm]);
          queue.push([levelName, level.data]);
          queue.push([levelName, level.useBackground.item.image]);
          if (await db.get("SELECT * FROM levels WHERE name = ?", levelName)) {
            shouldExit = true;
            return;
          }
          const index = i + pageNumber * 20 + 1;

          await db.run(
            "INSERT INTO levels (name, title, artists, author, description, rating, index_) VALUES (?, ?, ?, ?, ?, ?, ?)",
            levelName,
            level.title,
            level.artists,
            level.author,
            data.description,
            level.rating,
            startTime - index
          );
        }
      )
    );
    if (shouldExit) {
      queue.push(false);
      break;
    }
  }
};

(async () => {
  db = await open({
    filename: "./archive.db",
    driver: sqlite3.Database,
  });

  await db.run(
    "CREATE TABLE IF NOT EXISTS files (i INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, type TEXT, hash TEXT, url TEXT)"
  );
  await db.run(
    "CREATE TABLE IF NOT EXISTS levels (i INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, title TEXT, artists TEXT, author TEXT, description TEXT, rating INTEGER, index_ INTEGER)"
  );

  sender();
  collector();
})();

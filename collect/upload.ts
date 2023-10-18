import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import axios from "axios";
import { open } from "sqlite";
import sqlite3 from "sqlite3";
import { gunzip as gunzipCb, gzip as gzipCb } from "zlib";
import { promisify } from "util";
import axiosRetry from "axios-retry";
import https from "https";
import dotenv from "dotenv";

dotenv.config({ path: ".env" });
dotenv.config({ path: "../.env" });

const s3Client = new S3Client({
  endpoint: process.env.S3_ENDPOINT!,
  credentials: {
    accessKeyId: process.env.S3_USER!,
    secretAccessKey: process.env.S3_PASSWORD!,
  },
  region: process.env.S3_REGION!,
});

axiosRetry(axios, { retries: 3, retryDelay: () => 1000 });

let db: Awaited<ReturnType<typeof open>>;
const httpsAgent = new https.Agent({ keepAlive: true });

type File = {
  name: string;
  type: string;
  hash: string;
  url: string;
};
(async () => {
  db = await open({
    filename: "./archive.db",
    driver: sqlite3.Database,
  });

  for (const file of await db.all<File[]>("SELECT * FROM files")) {
    // const response = await axios.get(file.url, {
    //   responseType: "arraybuffer",
    //   httpsAgent,
    // });
    // await s3Client.send(
    //   new PutObjectCommand({
    //     Bucket: process.env.S3_BUCKET,
    //     Key: file.hash,
    //     Body: response.data,
    //   })
    // );
    console.log(`Uploaded ${file.hash} to S3`);
    await db.run("UPDATE files SET url = ? WHERE hash = ?", [
      process.env.S3_PUBLIC_URL + file.hash,
      file.hash,
    ]);

  }
})();

import dotenv from "dotenv";
import axios from "axios";
import { open } from "sqlite";
import sqlite3 from "sqlite3";
import axiosRetry from "axios-retry";
import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";

dotenv.config({ path: ".env" });
dotenv.config({ path: "../.env" });

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

(async () => {
  db = await open({
    filename: "./archive.db",
    driver: sqlite3.Database,
  });

  const allDbFiles = await db.all<{ url: string }[]>("SELECT url FROM files");
  const urls = new Set(allDbFiles.map((file) => file.url.split("/").pop()!));
  const allS3Files = new Set<string>();
  let startAfter: string | undefined;
  while (true) {
    const files = await s3Client.send(
      new ListObjectsV2Command({
        Bucket: process.env.S3_BUCKET!,
        StartAfter: startAfter,
      })
    );
    for (const file of files.Contents ?? []) {
      allS3Files.add(file.Key || "");
    }
    if (!files.IsTruncated) {
      break;
    }
    startAfter = files.Contents?.slice(-1)[0].Key;
  }
  console.log(`Found ${urls.size} unique URLs`);
  console.log(`Found ${allS3Files.size} unique S3 files`);
  let unusedFiles = new Set(
    [...allS3Files].filter((file) => !urls.has(file))
  );
  console.log(`Found ${unusedFiles.size} unused files`);

  let i = 0;
  while (unusedFiles.size > 0) {
    await s3Client.send(
      new DeleteObjectsCommand({
        Bucket: process.env.S3_BUCKET!,
        Delete: {
          Objects: [...unusedFiles].slice(0, 1000).map((Key) => ({ Key })),
        },
      })
    );
    i += 1000;
    unusedFiles = new Set([...unusedFiles].slice(1000));
  }
})();

import assert from "assert";
import { open } from "sqlite";
import sqlite3 from "sqlite3";

let db: Awaited<ReturnType<typeof open>>;

(async () => {
  db = await open({
    filename: "./archive.db",
    driver: sqlite3.Database,
  });

  const levels: {
    i: number;
    name: string;
    title: string;
    artists: string;
    author: string;
    description: string;
    rating: number;
  }[] = await db.all("SELECT * FROM levels");
  for (const level of levels) {
    const files = await db.all(
      "SELECT * FROM files WHERE name = ?",
      level.name
    );
    assert(files.length === 4, `${level.name} has ${files.length} files`);
  }
})();

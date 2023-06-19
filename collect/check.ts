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
  console.log(`Found ${levels.length} levels`);
  let errors = 0;
  for (const level of levels) {
    const files = await db.all(
      "SELECT * FROM files WHERE name = ?",
      level.name
    );
    if (files.length !== 5) {
      console.error(
        `${level.name} has ${files.length} files: ${files
          .map((file) => file.type)
          .join(", ")}`
      );
      errors++;
    }
  }
  if (errors === 0) {
    console.log("All levels have 5 files");
  }
})();

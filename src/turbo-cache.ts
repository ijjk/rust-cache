import fs from "fs";
import os from "os";
import path from "path";
import fetch from "node-fetch";
import { execa } from "execa";

export { ReserveCacheError, ValidationError } from "@actions/cache";

type CacheInt = typeof import("@actions/cache");

export const isFeatureAvailable: CacheInt["isFeatureAvailable"] = () => true;

const turboApi = process.env.TURBO_API || "https://vercel.com";
const turboTeam = process.env.TURBO_TEAM;
const turboToken = process.env.TURBO_TOKEN;

if (!turboToken) {
  throw new Error(`TURBO_TOKEN env is missing`);
}

export const saveCache: CacheInt["saveCache"] = async function saveCache(
  paths,
  key,
  _options,
  _enableCrossOsArchive
) {
  const cwd = process.cwd();
  const workDir = path.join(os.tmpdir(), `rust-cache-${Date.now()}`);
  await fs.promises.mkdir(workDir, { recursive: true });

  for (const p of paths) {
    const relativePath = path.relative(cwd, p);
    await fs.promises.rename(p, path.join(workDir, relativePath));
  }

  await execa("tar", ["--zstd", "-cf", `${workDir}.tar.zstd`, "."], {
    cwd: workDir,
    stdio: "inherit",
  });
  const body = fs.createReadStream(`${workDir}.tar.zstd`);

  const res = await fetch(
    `${turboApi}/v8/artifacts/${key}${turboTeam ? `?slug=${turboTeam}` : ""}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${turboToken}`,
      },
      body,
    }
  );
  await fs.promises.unlink(`${workDir}.tar.zstd`);

  if (!res.ok) {
    console.error(`Failed to save cache ${res.status}, ${await res.text()}`);
  }
  return 0;
};

export const restoreCache: CacheInt["restoreCache"] =
  async function restoreCache(_paths, primaryKey, restoreKeys, _options) {
    const keys = [primaryKey, ...(restoreKeys || [])];
    console.log(`Checking restore keys`, keys);

    let restoreKey = "";

    for (const key of keys) {
      const res = await fetch(
        `${turboApi}/v8/artifacts/${key}${
          turboTeam ? `?slug=${turboTeam}` : ""
        }`,
        {
          method: "HEAD",
          headers: {
            Authorization: `Bearer ${turboToken}`,
          },
        }
      );

      if (res.ok) {
        restoreKey = key;
        break;
      }
      console.log(`${key} had cache miss`);
    }

    if (!restoreKey) {
      return;
    }
    console.log(`Using restoreKey ${restoreKey}`);

    const cacheFile = path.join(os.tmpdir(), `rust-cache-${restoreKey}.tar.zstd`);

    const res = await fetch(
      `${turboApi}/v8/artifacts/${restoreKey}${
        turboTeam ? `?slug=${turboTeam}` : ""
      }`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${turboToken}`,
        },
      }
    );

    if (!res.ok) {
      return;
    }

    await new Promise((resolve, reject) => {
      const writeStream = fs.createWriteStream(cacheFile);
      res.body
        ?.pipe(writeStream)
        .on("close", () => {
          resolve(0);
        })
        .on("error", (error) => {
          reject(error);
        });
    });
    console.log("Wrote cache file", cacheFile);

    const workDir = path.join(os.tmpdir(), `rust-cache-${Date.now()}`);
    await fs.promises.mkdir(workDir, { recursive: true });

    await execa("tar", ["--zstd", "-xf", `${cacheFile}`], {
      cwd: workDir,
      stdio: "inherit",
    });

    for (const p of await fs.promises.readdir(workDir)) {
      console.log("moving", p, "from cache");
      const dest = path.join(process.cwd(), p);
      await execa('rm', ['-rf', dest]);
      await execa('mv', [path.join(workDir, p), dest]);
    }
    
    await fs.promises.unlink(cacheFile);
    await execa('rm', ['-rf', workDir]);
    return restoreKey;
  };

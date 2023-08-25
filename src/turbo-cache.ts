import os from "os";
import tar from "tar";
import path from "path";
import fs from "fs-extra";
import fetch from "node-fetch";

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
  await fs.mkdir(workDir, { recursive: true });

  for (const p of paths) {
    const relativePath = path.relative(cwd, p);
    await fs.copy(p, path.join(workDir, relativePath));
  }

  await new Promise<void>(async (resolve, reject) => {
    tar.c(
      {
        gzip: true,
        cwd: workDir,
        file: path.join(`${workDir}.tgz`),
      },
      [...(await fs.readdir(workDir))],
      (err) => {
        if (err) {
          return reject(err);
        }
        resolve();
      }
    );
  });

  const body = await fs.readFile(`${workDir}.tgz`);

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

    const cacheFile = path.join(os.tmpdir(), `rust-cache-${restoreKey}.tgz`);

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

    await fs.writeFile(cacheFile, Buffer.from(await res.arrayBuffer()));
    console.log("Wrote cache file", cacheFile);

    const workDir = path.join(os.tmpdir(), `rust-cache-${Date.now()}`);
    await fs.mkdir(workDir, { recursive: true });

    await tar.x({
      cwd: workDir,
      file: cacheFile,
    });

    for (const p of await fs.readdir(workDir)) {
      console.log("moving", p, "from cache");
      await fs.move(path.join(workDir, p), path.join(process.cwd(), p), {
        overwrite: true,
      });
    }
    return restoreKey;
  };

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
const cwd = process.cwd();

export const saveCache: CacheInt["saveCache"] = async function saveCache(
  paths,
  key,
  _options,
  _enableCrossOsArchive
) {
  const manifestFile = path.join(cwd, "cache-manifest.txt");
  await fs.promises.writeFile(manifestFile, paths.join("\n"));

  const cacheFile = `rust-cache-${Date.now()}.tar.zstd`;

  await execa(
    "tar",
    ["--zstd", "--files-from", manifestFile, "-cf", cacheFile],
    {
      cwd,
      stdio: "inherit",
    }
  );
  const body = fs.createReadStream(cacheFile);

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
  await fs.promises.unlink(cacheFile);
  await fs.promises.unlink(manifestFile);

  if (res.ok) {
    console.log("Successfully uploaded cache", key);
  } else {
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

    const cacheFile = path.join(
      os.tmpdir(),
      `rust-cache-${restoreKey}.tar.zstd`
    );

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

    await execa("tar", ["--zstd", "-xf", `${cacheFile}`], {
      cwd,
      stdio: "inherit",
    });

    await fs.promises.unlink(cacheFile);
    return restoreKey;
  };

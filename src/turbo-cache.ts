import fs from "fs";
import path from "path";
import { execa } from "execa";
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
const cwd = process.cwd();

export const saveCache: CacheInt["saveCache"] = async function saveCache(
  paths,
  key,
  _options,
  _enableCrossOsArchive
) {
  const existsRes = await fetch(
    `${turboApi}/v8/artifacts/${key}${turboTeam ? `?slug=${turboTeam}` : ""}`,
    {
      method: "HEAD",
      headers: {
        Authorization: `Bearer ${turboToken}`,
      },
    }
  );

  if (existsRes.ok) {
    console.log("Cache already exists skipping save");
    return 0;
  }
  const cachePaths: string[] = [];

  for (const p of paths) {
    const relativePath = path.relative(cwd, p);

    if (!relativePath.startsWith("..")) {
      cachePaths.push(relativePath);
    }
  }

  const manifestFile = path.join(cwd, "cache-manifest.txt");
  await fs.promises.writeFile(manifestFile, cachePaths.join("\n"));

  const cacheFile = `rust-cache-${Date.now()}.tar.zstd`;
  
  await execa("tar", ["--version"], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  await execa("zstd", ["--version"], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  await execa(
    "tar",
    ["--zstd", "--files-from", "cache-manifest.txt", "-cf", cacheFile],
    {
      shell: process.env.SHELL || 'bash',
      stdio: ["ignore", "inherit", "inherit"],
      timeout: 2 * 60 * 1000,
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
    const cacheFile = path.join(cwd, `rust-cache-${restoreKey}.tar.zstd`);

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

    await execa("tar", ["--version"], {
      stdio: ["ignore", "inherit", "inherit"],
    });
    await execa("zstd", ["--version"], {
      stdio: ["ignore", "inherit", "inherit"],
    });
    await execa("tar", ["--zstd", "-xf", `${cacheFile}`], {
      cwd,
      shell: process.env.SHELL || 'bash',
      stdio: ["ignore", "inherit", "inherit"],
      timeout: 2 * 60 * 1000,
    });

    await fs.promises.unlink(cacheFile);
    return restoreKey;
  };

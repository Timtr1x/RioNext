import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { finished } from "node:stream/promises";
import { DomainError } from "../domain/errors.ts";

export interface StoredArtifact {
  id: string;
  campaign_id: string;
  hash: string;
  size: number;
  mime: string;
  path: string;
  truncated: boolean;
}

export interface DiskArtifact {
  campaign_id: string;
  path: string;
  hash: string | null;
  size: number;
  incomplete: boolean;
}

export class ArtifactStore {
  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true });
  }

  campaignDir(campaignId: string): string {
    return join(this.root, campaignId);
  }

  async put(campaignId: string, bytes: Buffer | string, mime = "text/plain"): Promise<StoredArtifact> {
    const buf = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes;
    const hash = createHash("sha256").update(buf).digest("hex");
    const dir = join(this.root, campaignId, hash.slice(0, 2));
    mkdirSync(dir, { recursive: true });
    const finalPath = join(dir, hash);
    const tmpPath = join(dir, `.tmp-${randomUUID()}`);
    writeFileSync(tmpPath, buf);
    renameSync(tmpPath, finalPath);
    const size = statSync(finalPath).size;
    if (size !== buf.length) {
      throw new DomainError("artifact_size_mismatch", "artifact size mismatch after write", "protocol_error");
    }
    return {
      id: `art_${hash}`,
      campaign_id: campaignId,
      hash,
      size,
      mime,
      path: finalPath,
      truncated: false,
    };
  }

  async read(path: string, offset = 0, length?: number): Promise<Buffer> {
    const all = await readFile(path);
    if (offset === 0 && length === undefined) return all;
    return all.subarray(offset, length === undefined ? undefined : offset + length);
  }

  verify(path: string, expectedHash: string): boolean {
    if (!existsSync(path)) return false;
    const buf = readFileSync(path);
    const hash = createHash("sha256").update(buf).digest("hex");
    return hash === expectedHash;
  }

  listOnDisk(campaignId: string): DiskArtifact[] {
    const root = this.campaignDir(campaignId);
    if (!existsSync(root)) return [];
    const out: DiskArtifact[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        const st = statSync(p);
        if (st.isDirectory()) {
          walk(p);
          continue;
        }
        const incomplete = name.startsWith(".tmp-");
        const hash = !incomplete && /^[0-9a-f]{64}$/.test(name) ? name : null;
        out.push({ campaign_id: campaignId, path: p, hash, size: st.size, incomplete });
      }
    };
    walk(root);
    return out;
  }
}

export { dirname, createWriteStream, finished };

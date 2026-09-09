import type { SshSpec } from "./machine-ssh.js";

/**
 * The DigitalOcean provisioner — first implementation of the
 * provisioned-ssh pattern (spec §Provisioner): create a droplet whose
 * cloud-init authorizes fez's key and installs Docker; after that it IS
 * an SshMachine. Stop = DELETE — no orphan possible, no idle billing.
 * ponytail: region fixed to the account default; a region picker when
 * someone outside the US asks.
 */
export const DO_SIZE = "s-1vcpu-2gb";
export const DO_IMAGE = "ubuntu-24-04-x64";
const API = "https://api.digitalocean.com/v2";

export type DoFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string }
) => Promise<{ status: number; json(): Promise<unknown> }>;

const realFetch: DoFetch = (url, init) => fetch(url, init) as never;

const headers = (token: string) => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });

function userData(publicKey: string): string {
  return [
    "#cloud-config",
    "ssh_authorized_keys:",
    `  - ${publicKey}`,
    "packages:",
    "  - docker.io",
    "runcmd:",
    "  - systemctl enable --now docker",
    "  - sed -i 's/^#\\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config",
    "  - systemctl reload ssh || systemctl reload sshd",
    "",
  ].join("\n");
}

interface DropletJson {
  droplet?: { id: number; status?: string; networks?: { v4?: { type: string; ip_address: string }[] }; message?: never };
  message?: string;
}

export async function doProvision(
  opts: { token: string; netuid: number; persona: string; servePorts: number[]; publicKey: string; keyPath: string },
  f: DoFetch = realFetch,
  pollDelayMs = 5000
): Promise<{ ref: string; ssh: SshSpec }> {
  const create = await f(`${API}/droplets`, {
    method: "POST",
    headers: headers(opts.token),
    body: JSON.stringify({
      name: `fez-${opts.netuid}-${opts.persona}`,
      size: DO_SIZE,
      image: DO_IMAGE,
      user_data: userData(opts.publicKey),
      tags: ["fez-miner"],
    }),
  });
  const created = (await create.json()) as DropletJson;
  if (create.status >= 300 || !created.droplet) {
    throw new Error(`DO create failed (${create.status}): ${created.message ?? "unknown"}`);
  }
  const id = created.droplet.id;

  // Poll to active + public IPv4. 60 × pollDelayMs ceiling (5 min at the
  // default) — a droplet not active by then is a provision failure.
  for (let n = 0; n < 60; n++) {
    const r = await f(`${API}/droplets/${id}`, { headers: headers(opts.token) });
    const j = (await r.json()) as DropletJson;
    const ip = j.droplet?.networks?.v4?.find((v) => v.type === "public")?.ip_address;
    if (j.droplet?.status === "active" && ip) {
      return {
        ref: String(id),
        ssh: {
          host: ip,
          user: "root",
          keyPath: opts.keyPath,
          ports: opts.servePorts.map((p) => ({ externalIp: ip, externalPort: p, internalPort: p })),
        },
      };
    }
    await new Promise((res) => setTimeout(res, pollDelayMs));
  }
  throw new Error(`DO droplet ${id} never became active — check your DO dashboard; it may be billing`);
}

export async function doAlive(token: string, ref: string, f: DoFetch = realFetch): Promise<boolean> {
  const r = await f(`${API}/droplets/${ref}`, { headers: headers(token) });
  if (r.status === 404) return false;
  // Any other non-2xx (a 429 rate-limit, a 5xx hiccup) is UNKNOWN, not
  // dead — a caller reading "false" here would reprovision (and destroy
  // the still-live original) over what's really a transient API error.
  if (r.status >= 300) throw new Error(`DO droplet status check failed (${r.status})`);
  const j = (await r.json()) as DropletJson;
  return j.droplet?.status === "active" || j.droplet?.status === "new";
}

export async function doDestroy(token: string, ref: string, f: DoFetch = realFetch): Promise<void> {
  // 404 = already gone, i.e. destroy already succeeded from the caller's
  // point of view. Anything else non-2xx (401/5xx) — or the fetch itself
  // rejecting (network) — must propagate: a caller that swallows this and
  // clears its droplet-id state orphans a still-billing droplet.
  const r = await f(`${API}/droplets/${ref}`, { method: "DELETE", headers: headers(token) });
  if (r.status >= 300 && r.status !== 404) {
    throw new Error(`DO droplet destroy failed (${r.status})`);
  }
}

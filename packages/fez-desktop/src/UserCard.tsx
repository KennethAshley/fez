import { useState } from "react";
import type { FezClient } from "@fezchat/client";
import Avatar from "./Avatar";
import { flash } from "./toast";
import { cardActions } from "./user-card-actions";

/**
 * The moderation home for one person. Opens from a face or a name, and
 * splits every action into two planes: authority (owner/admin, affects
 * everyone, red) and personal (mute, you-only, teal). Positioned like the
 * reaction picker; closes on backdrop click.
 */
export default function UserCard({
  pk,
  at,
  client,
  onClose,
}: {
  pk: string;
  at: { x: number; y: number };
  client: FezClient;
  onClose: () => void;
}) {
  const [timeoutOpen, setTimeoutOpen] = useState(false);
  const [banOpen, setBanOpen] = useState(false);
  const [banReason, setBanReason] = useState("");

  const myRole = client.state.roleOf(client.pubkey);
  const targetRole = client.state.roleOf(pk);
  const amOwner = client.state.isOwner(client.pubkey);
  const isSelf = pk === client.pubkey;
  const a = cardActions(myRole, targetRole, amOwner, isSelf);
  const name = client.displayName(pk);
  const badge = targetRole === "bot" ? "agent" : targetRole;

  const act = (label: string, fn: () => Promise<unknown>) => async () => {
    try {
      await fn();
      flash(label);
    } catch (e) {
      flash(`✗ ${e instanceof Error ? e.message : String(e)}`);
    }
    onClose();
  };

  const timeout = (secs: number, label: string) =>
    act(`timed out ${name} · ${label}`, () => client.banUser(pk, Math.floor(Date.now() / 1000) + secs));

  const hasAuthority = a.makeAdmin || a.removeAdmin || a.timeout || a.kick || a.ban;

  return (
    <>
      <div className="menu-backdrop" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div
        className="ucard"
        role="dialog"
        aria-label={name}
        style={{ left: Math.max(8, Math.min(at.x, window.innerWidth - 268)), top: Math.max(8, Math.min(at.y, window.innerHeight - 360)) }}
      >
        <div className="ucard-top">
          <Avatar pk={pk} size={40} title={name} quip={false} />
          <div className="ucard-id">
            <div className="ucard-name">
              {name}
              {client.isOnline(pk) && <span className="ucard-presence" title="online" />}
            </div>
            <div className="ucard-npub">{`npub ${pk.slice(0, 8)}…${pk.slice(-4)}`}{badge ? ` · ${badge}` : ""}</div>
          </div>
        </div>

        <div className="ucard-list">
          {hasAuthority && (
            <>
              <div className="ucard-grp auth"><span className="ucard-sw" /> Moderator actions</div>
              {a.makeAdmin && (
                <div className="ucard-mi" onClick={act(`made ${name} an admin`, () => client.promote(pk))}>
                  <span className="ucard-gl">↑</span> Make admin
                </div>
              )}
              {a.removeAdmin && (
                <div className="ucard-mi" onClick={act(`removed ${name}'s admin`, () => client.demote(pk))}>
                  <span className="ucard-gl">↓</span> Remove admin
                </div>
              )}
              {a.timeout && (
                <>
                  <div className="ucard-mi" onClick={() => setTimeoutOpen((v) => !v)}>
                    <span className="ucard-gl">⏱</span> Time out<span className="ucard-sk">{timeoutOpen ? "▾" : "▸"}</span>
                  </div>
                  {timeoutOpen && (
                    <div className="ucard-presets">
                      <span onClick={timeout(300, "5 min")}>5 min</span>
                      <span onClick={timeout(3600, "1 hour")}>1 hour</span>
                      <span onClick={timeout(86400, "1 day")}>1 day</span>
                      <span onClick={timeout(604800, "1 week")}>1 week</span>
                    </div>
                  )}
                </>
              )}
              {a.kick && (
                <div className="ucard-mi" onClick={act(`removed ${name}`, () => client.kick(pk))}>
                  <span className="ucard-gl">×</span> Kick from workspace
                </div>
              )}
              {a.ban && (
                <>
                  <div className="ucard-mi danger" onClick={() => setBanOpen((v) => !v)}>
                    <span className="ucard-gl">⊘</span> Ban from this workspace
                    <span className="ucard-sk">{banOpen ? "▾" : "▸"}</span>
                  </div>
                  {banOpen && (
                    <div className="ucard-reason">
                      <input
                        value={banReason}
                        autoFocus
                        placeholder="reason (optional) — recorded in the ban"
                        onChange={(e) => setBanReason(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Escape") setBanOpen(false);
                          if (e.key === "Enter") void act(`banned ${name}`, () => client.banUser(pk, undefined, banReason.trim() || undefined))();
                        }}
                      />
                      <button onClick={act(`banned ${name}`, () => client.banUser(pk, undefined, banReason.trim() || undefined))}>
                        Ban
                      </button>
                    </div>
                  )}
                </>
              )}
            </>
          )}

          {a.mute && (
            <>
              {hasAuthority && <div className="ucard-rule" />}
              <div className="ucard-grp self"><span className="ucard-sw" /> Just for you</div>
              {client.isMutedByMe(pk) ? (
                <div className="ucard-mi calm" onClick={act(`unmuted ${name}`, () => client.unmutePerson(pk))}>
                  <span className="ucard-gl">🔊</span> Unmute this person
                </div>
              ) : (
                <div
                  className="ucard-mi calm"
                  title="hides them from your view only — they can't tell"
                  onClick={act(`muted ${name} — just for you`, () => client.mutePerson(pk))}
                >
                  <span className="ucard-gl">🔇</span> Mute this person
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}

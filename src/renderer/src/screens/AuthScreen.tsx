import { useEffect, useState, type ReactNode } from "react";
import type { AppState, UnitInfo } from "@shared/types";
import logo from "../assets/logo.svg";
import Icon from "../components/Icon";

type Mode = "main" | "recover" | "show-key";

function LoginShell({ children }: { children: ReactNode }) {
  return (
    <div className="login">
      <aside className="login-brand">
        <div>
          <img className="login-logo" src={logo} alt="" />
          <h1>BookKeeper</h1>
          <p className="login-tagline">Enter. Preview. Record. Report.</p>
        </div>
        <ul className="login-points">
          <li>Encrypted on this computer</li>
          <li>Works fully offline</li>
          <li>Excel and Word reports in seconds</li>
        </ul>
        <div className="login-version">Version {__APP_VERSION__}</div>
      </aside>
      <main className="login-main">
        <div className="auth">{children}</div>
      </main>
    </div>
  );
}

export default function AuthScreen({
  state,
  onDone,
}: {
  state: AppState;
  onDone: () => void;
}) {
  const [mode, setMode] = useState<Mode>("main");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [rk, setRk] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [recoveryKey, setRecoveryKey] = useState("");
  const [saved, setSaved] = useState(false);
  const [showPw, setShowPw] = useState(false);
  const [caps, setCaps] = useState(false);
  const creating = state === "no-vault";
  const [unitName, setUnitName] = useState("Unit 1");
  const [unitList, setUnitList] = useState<UnitInfo[]>([]);
  const [unitId, setUnitId] = useState("");

  // The unit list is readable before unlock, so the picker can show names.
  useEffect(() => {
    if (creating) return;
    window.api.units.list().then(({ units, lastUsedId }) => {
      setUnitList(units);
      setUnitId(lastUsedId ?? units[0]?.id ?? "");
    });
  }, [creating]);

  async function submit() {
    if (busy) return;
    setErr("");
    setBusy(true);
    try {
      if (creating) {
        if (pw !== pw2) return setErr("Passwords do not match");
        const r = await window.api.vault.create(pw, unitName);
        if (!r.ok) return setErr(r.error ?? "Could not create");
        setRecoveryKey(r.data!.recoveryKey);
        setMode("show-key");
      } else if (mode === "recover") {
        if (!unitId) return setErr("No unit found");
        if (pw !== pw2) return setErr("Passwords do not match");
        const r = await window.api.vault.unlockWithRecoveryKey(unitId, rk, pw);
        r.ok ? onDone() : setErr(r.error ?? "Failed");
      } else {
        if (!unitId) return setErr("No unit found");
        const r = await window.api.vault.unlock(unitId, pw);
        r.ok ? onDone() : setErr(r.error ?? "Failed");
      }
    } finally {
      setBusy(false);
    }
  }

  // Shown once after setup. TODO: "skip" path (keep an encrypted copy in the DB, max 2 views, reminder banner).
  if (mode === "show-key") {
    return (
      <LoginShell>
        <h3>Save your recovery key</h3>
        <p className="muted">
          This is the only way back in if you forget your password. Write it
          down or print it and keep it somewhere safe.
        </p>
        <p className="rk">{recoveryKey}</p>
        <p
          style={{
            display: "flex",
            gap: 8,
            alignItems: "center",
            marginTop: 12,
          }}
        >
          <button onClick={() => window.print()}>Print</button>
          <label className="check">
            <input
              type="checkbox"
              checked={saved}
              onChange={(e) => setSaved(e.target.checked)}
            />{" "}
            I have saved my recovery key
          </label>
        </p>
        <button className="primary" disabled={!saved} onClick={onDone}>
          Continue
        </button>
      </LoginShell>
    );
  }

  return (
    <LoginShell>
      <h3>
        {creating
          ? "Create master password"
          : mode === "recover"
            ? "Reset with recovery key"
            : "Unlock BookKeeper"}
      </h3>
      {creating && (
        <p className="muted">
          Minimum 8 characters. Your data is encrypted with it and never leaves
          this computer.
        </p>
      )}
      {creating && (
        <div className="field">
          <label>Unit name (you can add more units later in Settings)</label>
          <input
            value={unitName}
            maxLength={40}
            onChange={(e) => setUnitName(e.target.value)}
          />
        </div>
      )}
      {!creating && unitList.length > 1 && (
        <div className="field">
          <label>Unit</label>
          <select value={unitId} onChange={(e) => setUnitId(e.target.value)}>
            {unitList.map((u) => (
              <option key={u.id} value={u.id}>
                {u.display}
              </option>
            ))}
          </select>
        </div>
      )}
      {!creating && unitList.length === 1 && (
        <p className="muted">{unitList[0].display}</p>
      )}
      {mode === "recover" && (
        <div className="field">
          <label>Recovery key</label>
          <input
            value={rk}
            onChange={(e) => setRk(e.target.value)}
            className="mono"
          />
        </div>
      )}
      <div className="field">
        <label>{mode === "recover" ? "New password" : "Password"}</label>
        <div className="pw-wrap">
          <input
            type={showPw ? "text" : "password"}
            autoFocus
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            onKeyDown={(e) => {
              setCaps(e.getModifierState("CapsLock"));
              if (e.key === "Enter" && !creating && mode === "main") submit();
            }}
            onKeyUp={(e) => setCaps(e.getModifierState("CapsLock"))}
            onBlur={() => setCaps(false)}
          />
          <button
            type="button"
            className="pw-eye"
            tabIndex={-1}
            aria-label={showPw ? "Hide password" : "Show password"}
            aria-pressed={showPw}
            onClick={() => setShowPw((v) => !v)}
          >
            <Icon name={showPw ? "eyeOff" : "eye"} />
          </button>
        </div>
        {caps && <p className="caps-warn">Caps Lock is on</p>}
      </div>
      {(creating || mode === "recover") && (
        <div className="field">
          <label>Confirm password</label>
          <input
            type={showPw ? "text" : "password"}
            value={pw2}
            onChange={(e) => setPw2(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
        </div>
      )}
      {err && <p className="error">{err}</p>}
      <button className="primary" disabled={busy} onClick={submit}>
        {creating ? "Create" : mode === "recover" ? "Reset & unlock" : "Unlock"}
      </button>
      {!creating && (
        <p style={{ marginTop: 12 }}>
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              setErr("");
              setMode(mode === "recover" ? "main" : "recover");
            }}
          >
            {mode === "recover" ? "Back" : "Forgot password?"}
          </a>
        </p>
      )}
    </LoginShell>
  );
}

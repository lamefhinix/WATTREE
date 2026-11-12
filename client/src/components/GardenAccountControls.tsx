import { useState } from "react";
import { ChevronDown, ChevronRight, Leaf, UserRound } from "lucide-react";
import { toast } from "sonner";
import { Link } from "wouter";
import { startLogin } from "@/const";
import { useAuth } from "@/_core/hooks/useAuth";
import { Modal } from "@/components/WatreeUI";
import { useWatree } from "@/lib/watree";
import type { Garden } from "@shared/watree-live";
import "../account.css";

type GardenControlsContext = {
  isDemo: boolean;
  user: { name?: string | null; email?: string | null } | null;
  gardens: Garden[];
  garden: Garden | null;
  selectGarden: (id: number) => void;
  enterDemo: () => void;
  createGarden: (input: { name: string; location?: string }) => Promise<void>;
};

function messageFor(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function initialsFor(name: string) {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map(part => part[0]?.toUpperCase())
      .join("") || "G"
  );
}

export function GardenSwitcher() {
  const auth = useAuth();
  const live = useWatree();
  const [open, setOpen] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [location, setLocation] = useState("");
  const [pending, setPending] = useState(false);
  const user = live.user ?? auth.user;

  async function login() {
    try {
      startLogin();
    } catch (error) {
      toast.error(messageFor(error, "Could not start Manus sign-in."));
    }
  }

  async function createGarden(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim() || pending) return;
    setPending(true);
    try {
      await live.createGarden({
        name: name.trim(),
        location: location.trim() || undefined,
      });
      setName("");
      setLocation("");
      setCreateOpen(false);
      setOpen(false);
      toast.success("Garden created.");
    } catch (error) {
      toast.error(messageFor(error, "Could not create the garden."));
    } finally {
      setPending(false);
    }
  }

  function handleOpen() {
    if (!user) {
      setLoginOpen(true);
      return;
    }
    setOpen(value => !value);
  }

  return (
    <>
      <button
        className="garden-switch"
        type="button"
        onClick={handleOpen}
        aria-expanded={open || loginOpen || createOpen}
        aria-haspopup="dialog"
      >
        <span className="garden-icon">
          <Leaf size={17} />
        </span>
        <span className="garden-switch-copy">
          <strong>
            {live.garden?.name ||
              (live.isDemo ? "Demo garden" : "Create a garden")}
          </strong>
          <small>
            {live.isDemo
              ? "Sample workspace"
              : live.garden?.location || "Real workspace"}
          </small>
        </span>
        <ChevronDown size={14} />
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Choose your garden"
        description="Switch between gardens saved to your real Watree account, or keep browsing the demo."
      >
        <div className="garden-choice-list">
          {live.gardens.map(item => (
            <button
              key={item.id}
              className={`garden-choice ${live.garden?.id === item.id ? "selected" : ""}`}
              type="button"
              onClick={() => {
                live.selectGarden(item.id);
                setOpen(false);
              }}
            >
              <span className="garden-icon">
                <Leaf size={16} />
              </span>
              <span>
                <strong>{item.name}</strong>
                <small>{item.location || "No location set"}</small>
              </span>
              {live.garden?.id === item.id && (
                <span className="garden-choice-check">Current</span>
              )}
            </button>
          ))}
          {!live.gardens.length && user && (
            <div className="account-empty">
              <Leaf size={18} />
              <span>No real gardens yet. Create one to begin.</span>
            </div>
          )}
          <div className="garden-choice-actions">
            <button
              className="button primary full"
              type="button"
              onClick={() => {
                setOpen(false);
                setCreateOpen(true);
              }}
            >
              Create a garden
            </button>
            <button
              className="button secondary full"
              type="button"
              onClick={() => {
                live.enterDemo();
                setOpen(false);
              }}
            >
              Browse demo garden
            </button>
          </div>
        </div>
      </Modal>
      <Modal
        open={loginOpen}
        onClose={() => setLoginOpen(false)}
        title="Your garden starts with an account"
        description="Use Manus OAuth to sign in or create your Watree account. Watree does not collect a separate password."
      >
        <div className="account-login-dialog">
          <div className="account-hero-icon">
            <UserRound size={23} />
          </div>
          <p>
            After sign-in, the sidebar will let you create and switch between
            real gardens. New accounts begin empty.
          </p>
          <button className="button primary full" type="button" onClick={login}>
            Sign in / create account
          </button>
          <button
            className="button secondary full"
            type="button"
            onClick={() => {
              live.enterDemo();
              setLoginOpen(false);
            }}
          >
            Browse demo instead
          </button>
        </div>
      </Modal>
      <Modal
        open={createOpen}
        onClose={() => !pending && setCreateOpen(false)}
        title="Create a real garden"
        description="This garden will be saved to your Watree account and starts without sample plants or devices."
      >
        <form className="form-stack" onSubmit={createGarden}>
          <label>
            Garden name
            <input
              value={name}
              onChange={event => setName(event.target.value)}
              placeholder="e.g. Kitchen window"
              maxLength={80}
              required
            />
          </label>
          <label>
            Location <span className="optional-label">optional</span>
            <input
              value={location}
              onChange={event => setLocation(event.target.value)}
              placeholder="e.g. Home"
              maxLength={120}
            />
          </label>
          <button
            className="button primary full"
            type="submit"
            disabled={pending}
          >
            {pending ? "Creating…" : "Create garden"}
          </button>
        </form>
      </Modal>
    </>
  );
}

export function AccountAvatar({ small = false }: { small?: boolean }) {
  const auth = useAuth();
  const live = useWatree() as unknown as Pick<
    GardenControlsContext,
    "isDemo" | "user"
  >;
  const user = live.user ?? auth.user;
  const label = live.isDemo ? "Demo" : user?.name || "Guest";
  return (
    <Link
      href="/settings"
      className={`avatar ${small ? "small" : ""}`}
      aria-label="Open account settings"
      title={user?.email || label}
    >
      {live.isDemo ? "D" : initialsFor(label)}
    </Link>
  );
}

export function GardenAccountIdentity() {
  const auth = useAuth();
  const live = useWatree() as unknown as Pick<
    GardenControlsContext,
    "isDemo" | "user"
  >;
  const user = live.user ?? auth.user;
  const label = live.isDemo ? "Demo" : user?.name || "Guest";
  return (
    <Link href="/settings" className="user-profile">
      <AccountAvatar />
      <span>
        <strong>{label}</strong>
        <small>
          {live.isDemo
            ? "Sample workspace"
            : user?.email || "Sign in to save your garden"}
        </small>
      </span>
      <ChevronRight size={16} />
    </Link>
  );
}

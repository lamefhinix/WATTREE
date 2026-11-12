import { useState } from "react";
import { Link, Route, Switch, useLocation } from "wouter";
import {
  LayoutDashboard,
  Sprout,
  Droplets,
  ChartNoAxesCombined,
  SlidersHorizontal,
  Settings,
  Bell,
  ArrowUpRight,
  CircleHelp,
  Menu,
  X,
  Wifi,
  Leaf,
  ChevronRight,
  PlugZap,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import ErrorBoundary from "@/components/ErrorBoundary";
import NotFound from "@/pages/NotFound";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { WatreeProvider, useWatree, getPlantStatus } from "@/lib/watree";
import { BrandMark, Modal } from "@/components/WatreeUI";
import { GardenSwitcher } from "@/components/GardenAccountControls";
import AccountSettings from "@/pages/AccountSettings";
import DevicesPage from "@/pages/DevicesPage";
import {
  Overview,
  Plants,
  PlantDetail,
  Activity,
  Analytics,
  Automation,
} from "@/pages/GardenPages";
const links = [
  { path: "/", title: "Overview", icon: LayoutDashboard },
  { path: "/plants", title: "My plants", icon: Sprout },
  { path: "/activity", title: "Watering activity", icon: Droplets },
  { path: "/analytics", title: "Analytics", icon: ChartNoAxesCombined },
  { path: "/automation", title: "Automation", icon: SlidersHorizontal },
  { path: "/devices", title: "Devices & setup", icon: PlugZap },
];
function GardenShell() {
  const [location] = useLocation();
  const {
    plants,
    system,
    isDemo,
    user,
    garden,
    devices,
    liveLoading,
    liveError,
    refreshLive,
    enterDemo,
  } = useWatree();
  const [menuOpen, setMenuOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const attention = system.notifications
    ? plants.filter(p => getPlantStatus(p) === "attention")
    : [];
  const title = location.startsWith("/plants/")
    ? "Plant details"
    : location === "/settings"
      ? "Settings"
      : links.find(l => l.path === location)?.title || "Watree";
  const name =
    user?.name ||
    user?.email?.split("@")[0] ||
    (isDemo ? "Demo visitor" : "Guest");
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map(w => w[0])
    .join("")
    .toUpperCase();
  const online = devices.filter(
    d =>
      !d.revoked &&
      d.lastSeenAt &&
      Date.now() - new Date(d.lastSeenAt).getTime() < 120000
  ).length;
  const connection = isDemo
    ? "Demo mode"
    : online
      ? `${online} device${online === 1 ? "" : "s"} online`
      : "No device online";
  return (
    <div className="app-shell">
      {menuOpen && (
        <div className="sidebar-scrim" onClick={() => setMenuOpen(false)} />
      )}
      <aside className={`sidebar ${menuOpen ? "open" : ""}`}>
        <Link href="/" className="brand" onClick={() => setMenuOpen(false)}>
          <BrandMark />
          <span>
            watree<span className="brand-period">.</span>
          </span>
        </Link>
        <button
          className="mobile-close icon-button"
          aria-label="Close navigation"
          onClick={() => setMenuOpen(false)}
        >
          <X size={20} />
        </button>
        <GardenSwitcher />
        <span className="nav-caption">WORKSPACE</span>
        <nav aria-label="Main navigation">
          {links.map(({ path, title: label, icon: Icon }) => (
            <Link
              key={path}
              href={path}
              onClick={() => setMenuOpen(false)}
              className={`nav-link ${(path === "/" ? location === "/" : location.startsWith(path)) ? "active" : ""}`}
            >
              <Icon size={19} />
              <span>{label}</span>
              {path === "/plants" && (
                <span className="nav-count">{plants.length}</span>
              )}
            </Link>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-system">
            <span
              className={`status-dot ${!system.enabled || (!isDemo && !online) ? "paused-dot" : ""}`}
            />
            <strong>
              {isDemo
                ? "Explore the demo"
                : online
                  ? system.enabled
                    ? "Device connected"
                    : "Watering paused"
                  : "Setup waiting for connection"}
            </strong>
            <span>
              {isDemo
                ? "Sample watering system"
                : garden?.name || "Create your real garden"}
            </span>
            <Link href="/devices">
              Link my setup <ArrowUpRight size={13} />
            </Link>
          </div>
          <button className="nav-link" onClick={() => setHelpOpen(true)}>
            <CircleHelp size={19} />
            Help & getting started
          </button>
          <Link
            href="/settings"
            className={`nav-link ${location === "/settings" ? "active" : ""}`}
            onClick={() => setMenuOpen(false)}
          >
            <Settings size={19} />
            Account & settings
          </Link>
          <Link href="/settings" className="user-profile">
            <span className="avatar">{initials}</span>
            <div>
              <strong>{name}</strong>
              <small>
                {user
                  ? "Garden account"
                  : isDemo
                    ? "Demo browsing"
                    : "Sign in to save your garden"}
              </small>
            </div>
            <ChevronRight size={16} />
          </Link>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="topbar-left">
            <button
              className="mobile-menu icon-button"
              aria-label="Open navigation"
              onClick={() => setMenuOpen(true)}
            >
              <Menu size={22} />
            </button>
            <span className="breadcrumb">
              {isDemo ? "Demo" : garden?.name || "Workspace"}
              <ChevronRight size={13} />
              <strong>{title}</strong>
            </span>
          </div>
          <div className="topbar-right">
            <Link href="/devices" className="connection">
              <Wifi size={13} />
              {connection}
            </Link>
            <div className="notification-anchor">
              <button
                className="icon-button notification-button"
                aria-label="View notifications"
                aria-expanded={notificationsOpen}
                onClick={() => setNotificationsOpen(!notificationsOpen)}
              >
                <Bell size={19} />
                {attention.length > 0 && <i />}
              </button>
              {notificationsOpen && (
                <div className="notification-panel">
                  <div className="notification-title">
                    <strong>Garden updates</strong>
                    <button
                      className="icon-button"
                      aria-label="Close notifications"
                      onClick={() => setNotificationsOpen(false)}
                    >
                      <X size={15} />
                    </button>
                  </div>
                  {attention.length ? (
                    attention.map(p => (
                      <Link
                        href={`/plants/${p.id}`}
                        key={p.id}
                        onClick={() => setNotificationsOpen(false)}
                        className="notification-entry"
                      >
                        <Droplets size={17} />
                        <div>
                          <strong>{p.name} needs a little care</strong>
                          <span>Moisture is {p.moisture}%.</span>
                        </div>
                        <ArrowUpRight size={14} />
                      </Link>
                    ))
                  ) : (
                    <div className="notification-entry">
                      <Leaf size={17} />
                      <div>
                        <strong>
                          {!system.notifications
                            ? "Garden alerts are paused"
                            : plants.some(
                                  p =>
                                    getPlantStatus(p) === "unknown" ||
                                    getPlantStatus(p) === "stale"
                                )
                              ? "Waiting for fresh sensor readings"
                              : "No plant-care alerts"}
                        </strong>
                        <span>
                          {system.notifications
                            ? "Only fresh measurements are used for care alerts."
                            : "Turn alerts on in Account & settings."}
                        </span>
                      </div>
                    </div>
                  )}
                  <div className="notification-foot">
                    {isDemo
                      ? "Sample updates from the demo garden"
                      : "Updates from your garden's sensor readings"}
                  </div>
                </div>
              )}
            </div>
            <span className="topbar-divider" />
            <Link
              href="/settings"
              className="avatar small"
              aria-label="Open account settings"
            >
              {initials}
            </Link>
          </div>
        </header>
        <main className="page-content">
          {!isDemo &&
            location !== "/settings" &&
            location !== "/devices" &&
            (!garden || Boolean(liveError)) && (
              <div className="panel onboarding-notice">
                <div>
                  <h2>
                    {liveError
                      ? "We couldn't load your garden"
                      : user
                        ? "Your real garden starts here"
                        : "Make this your garden."}
                  </h2>
                  <p>
                    {liveError
                      ? liveError instanceof Error
                        ? liveError.message
                        : "Please retry or check your account."
                      : user
                        ? "Create a named garden, add your plants, and link your controller."
                        : "Create an account to save your plants and connect your actual watering setup."}
                  </p>
                </div>
                <div>
                  {Boolean(liveError) && (
                    <button
                      className="button secondary"
                      onClick={() =>
                        refreshLive().catch(e => toast.error(e.message))
                      }
                    >
                      <RefreshCw size={14} />
                      Retry
                    </button>
                  )}
                  <Link href="/settings" className="button primary">
                    {user ? "Set up my garden" : "Sign in / Create account"}
                    <ArrowUpRight size={14} />
                  </Link>
                  <button className="button secondary" onClick={enterDemo}>
                    Explore demo
                  </button>
                </div>
              </div>
            )}
          {liveLoading && location !== "/settings" ? (
            <div className="empty-state">
              <Loader2 className="spin" />
              <p>Loading your garden…</p>
            </div>
          ) : (
            <Switch>
              <Route path="/" component={Overview} />
              <Route path="/plants" component={Plants} />
              <Route path="/plants/:id">
                {params => <PlantDetail id={params.id} />}
              </Route>
              <Route path="/activity" component={Activity} />
              <Route path="/analytics" component={Analytics} />
              <Route path="/automation" component={Automation} />
              <Route path="/devices" component={DevicesPage} />
              <Route path="/settings" component={AccountSettings} />
              <Route component={NotFound} />
            </Switch>
          )}
          <footer className="page-footer">
            <span>A little care. A lot of growth.</span>
            <span>
              <BrandMark size={14} />
              Thoughtfully grown with Watree
            </span>
          </footer>
        </main>
      </div>
      <Modal
        open={helpOpen}
        onClose={() => setHelpOpen(false)}
        title="From your roots to your dashboard"
        description="Watree connects your garden account to your real watering controller."
      >
        <div className="help-content">
          <div>
            <span className="help-number">01</span>
            <section>
              <h3>Create your garden account</h3>
              <p>
                Sign in securely, create a named garden, and save your plants in
                the cloud.
              </p>
            </section>
          </div>
          <div>
            <span className="help-number">02</span>
            <section>
              <h3>Link your actual setup</h3>
              <p>
                Register a device, copy its one-time token, and map each plant
                to a controller channel. Send authenticated HTTPS readings from
                your firmware.
              </p>
            </section>
          </div>
          <div>
            <span className="help-number">03</span>
            <section>
              <h3>Water with confidence</h3>
              <p>
                Water now queues a bounded command. Your device polls for it and
                reports the actual amount delivered. Calibrate and safety-test
                your hardware before enabling pumps.
              </p>
            </section>
          </div>
        </div>
        <Link
          href="/devices"
          className="button primary full"
          onClick={() => setHelpOpen(false)}
        >
          Connect my setup <ArrowUpRight size={16} />
        </Link>
      </Modal>
    </div>
  );
}
export default function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="light">
        <TooltipProvider>
          <WatreeProvider>
            <GardenShell />
            <Toaster position="bottom-right" />
          </WatreeProvider>
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

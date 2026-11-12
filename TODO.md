# Watree functional upgrade

Preserve the delivered botanical UI and its existing responsive pages. New user request: many buttons do not work; create settings where the user can change and create an account for their garden, and a system to link their actual watering setup.

- [x] Real sign-in/account creation uses validated Manus OAuth. Remove hardcoded profile identity, provide signed-out, loading, retry, and signed-in states, and allow logout.
- [x] Owners can create and switch real gardens; account/profile and garden settings are editable and saved in the managed database. Real gardens start empty, with no sample telemetry mixed into real data.
- [x] Plant creation, editing, care rules, garden settings, system/notification toggles, device setup, CSV export, and navigation controls have real handlers, visible success/error/pending feedback, and persisted owner-scoped data.
- [x] Owners register actual setups, receive a device token once, rotate/revoke it, see true heartbeat status, and map plants to device channels. Keys are hashed server-side and never returned in listings.
- [x] Token-authenticated HTTPS endpoints accept validated telemetry, provide expiring/cancelable commands, and record actual watering amounts only after an idempotent device acknowledgement. Ownership, device/channel matching, duplicate commands, data freshness, cooldown, maximum doses, and reservoir constraints are enforced.
- [x] Live manual watering queues real commands without claiming water was delivered. Automatic moisture rules may queue commands only on fresh telemetry when enabled and safe. Missing and stale sensor values are visibly distinct from readings; live charts use stored measurements rather than fabricated moisture trends.
- [x] Device setup includes endpoint/payload instructions, copy actions with error feedback, and downloadable protocol/integration examples. Hardware registration alone must not claim a connection; actual firmware integration depends on the user's controller details.
- [x] Keep a clearly separated anonymous demo and preserve desktop/mobile navigation. Update route manifest, use container serving for backend, run checks and focused integration tests without sending physical watering commands, and perform one read-only implementation review.

## Evidence

Managed server/database enabled; additive Drizzle migration applied. TypeScript check, production server/frontend build, and the existing test suite pass. HTTP health and route manifest return expected JSON; anonymous garden and device requests return 401. The workspace button opens an account dialog and sign-in redirects to the actual authentication portal. No user credentials were entered, no production garden/device test data was created, and no physical watering commands were issued.

Hardware-specific firmware adaptation and an end-to-end physical test remain dependent on the user’s controller/firmware details. Publication is not performed without an explicit publication request; use the published HTTPS URL for durable device connectivity.

Read-only implementation review completed. Confirmed issues were fixed: expired claims no longer reserve water indefinitely; disable/revoke records unknown delivery; a database uniqueness migration enforces one assigned plant per physical channel; watering amount tracks the saved dose; refetch errors propagate and the device refresh action shows pending/success/error feedback. Focused safety/helper regression tests and the final TypeScript/production build pass.

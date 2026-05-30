## ADDED Requirements

### Requirement: Theme persists in electron-store
The Electron app SHALL persist the user's theme preference (`light` | `dark`) in `electron-store` at key `appearance.theme`. Theme changes SHALL be written via `electronAPI.config.set("appearance.theme", value)` and read on startup via `electronAPI.config.get("appearance.theme")`.

#### Scenario: Theme change persists across restart
- **WHEN** user toggles theme to dark mode
- **THEN** `appearance.theme` is set to `"dark"` in electron-store
- **AND** on next app launch, the app renders in dark mode without user action

#### Scenario: Theme syncs across settings and sidebar
- **WHEN** user changes theme in the Appearance section
- **THEN** the InboxSidebar theme toggle reflects the new state immediately

### Requirement: Language persists in electron-store
The Electron app SHALL persist the user's language preference in `electron-store` at key `appearance.language`. The `LanguageSwitcher` component SHALL write the selected locale via IPC.

#### Scenario: Language change persists
- **WHEN** user selects a different language in the Appearance section
- **THEN** `appearance.language` is written to electron-store
- **AND** on next app launch, `i18next` initializes with the stored locale

### Requirement: Local UI preferences persist in electron-store
Client-only preferences (density, activity detail mode, code wrapping, brand logos) SHALL be stored under `appearance.preferences` in electron-store, replacing the WebUI's localStorage approach.

#### Scenario: Density preference persists
- **WHEN** user switches density from "comfortable" to "compact"
- **THEN** `appearance.preferences.density` is set to `"compact"` in electron-store
- **AND** the UI immediately reflects compact density

#### Scenario: Preferences survive app reinstall data migration
- **WHEN** electron-store data file exists from a previous version
- **THEN** the app reads and applies all stored preferences without error

### Requirement: useElectronPreference hook encapsulates IPC
A `useElectronPreference<T>(key, defaultValue)` hook SHALL provide reactive get/set for electron-store keys. It SHALL:
1. Read the initial value from electron-store on mount
2. Return `[value, setValue]` tuple
3. Call `electronAPI.config.set(key, newValue)` on setValue
4. Update local state immediately (optimistic)

#### Scenario: Hook reads initial value
- **WHEN** a component mounts with `useElectronPreference("appearance.theme", "light")`
- **THEN** the hook returns the value stored in electron-store (or the default if not set)

#### Scenario: Hook writes value
- **WHEN** `setValue("dark")` is called
- **THEN** local state updates to `"dark"` immediately
- **AND** `electronAPI.config.set("appearance.theme", "dark")` is invoked

### Requirement: electron-store schema extends for preferences
The `AppConfig` interface and store defaults SHALL include:
- `appearance.language: string` (default: `"en"`)
- `appearance.preferences: { density, activityMode, codeWrap, brandLogos }` with sensible defaults

#### Scenario: Fresh install uses defaults
- **WHEN** Electron app launches for the first time (no existing store file)
- **THEN** `appearance.language` is `"en"` and `appearance.preferences.density` is `"comfortable"`

## ADDED Requirements

### Requirement: Settings view renders all 8 sections
The Electron renderer SHALL provide a SettingsLayout component containing a left navigation sidebar and a content area. The navigation SHALL include exactly 8 section entries: Overview, Appearance, Models, Image, Web, Apps, Runtime, Advanced.

#### Scenario: User opens settings page
- **WHEN** user clicks the Settings gear icon in InboxSidebar
- **THEN** App view switches to "settings" and SettingsLayout renders with Overview section active by default

#### Scenario: User navigates between sections
- **WHEN** user clicks a section in the settings navigation
- **THEN** the content area renders the corresponding section component

### Requirement: Sidebar settings button is active
The InboxSidebar Settings button SHALL be enabled and clickable. It SHALL trigger a view transition from inbox to settings.

#### Scenario: Settings button triggers view switch
- **WHEN** user clicks the Settings nav item in InboxSidebar
- **THEN** `onOpenSettings` callback is invoked and App renders SettingsLayout

#### Scenario: Back navigation returns to inbox
- **WHEN** user clicks the back/close button in SettingsLayout header
- **THEN** App view switches back to inbox

### Requirement: Overview section displays system summary
The Overview section SHALL display cards summarizing current AI model, configured capabilities (web search, image generation, apps), and system info (gateway URL, workspace path).

#### Scenario: Overview shows current model
- **WHEN** settings data is loaded from `/api/settings`
- **THEN** Overview displays the active model preset name or model/provider combination

#### Scenario: Overview capability cards link to sections
- **WHEN** user clicks a capability card (e.g., "Web Search")
- **THEN** navigation switches to the corresponding section (e.g., "web")

### Requirement: Models section manages model and provider configuration
The Models section SHALL allow users to select model presets, configure BYOK providers (API keys, base URLs), and create new model configurations.

#### Scenario: Select model preset
- **WHEN** user selects a different model preset from the picker
- **THEN** system calls `/api/settings/update?model_preset=<slug>` and refreshes displayed model info

#### Scenario: Configure provider API key
- **WHEN** user enters an API key for a provider and saves
- **THEN** system calls `/api/settings/provider/update?provider=<name>&api_key=<value>` and updates the provider status indicator

#### Scenario: Create model configuration
- **WHEN** user fills in label, model name, provider and clicks save
- **THEN** system calls `/api/settings/model-configurations/create` with the parameters and the new preset appears in the picker

### Requirement: Models section exposes vision model configuration
The Models section SHALL display a "Vision model" group below the primary model group, containing a model name input and a provider picker (with an "Auto" option representing null/auto-detect). These fields SHALL be saved together with the primary model via the same `/api/settings/update` call.

#### Scenario: Configure vision model
- **WHEN** user enters a model name (e.g. `gemini-2.5-flash`) and selects a provider, then clicks Save
- **THEN** system calls `/api/settings/update?vision_model=<model>&vision_provider=<provider>` and the inputs reflect the saved values

#### Scenario: Clear vision model
- **WHEN** user clears the vision model input and clicks Save
- **THEN** system calls `/api/settings/update?vision_model=` (empty), backend stores `null`, disabling image captioning

#### Scenario: Auto-detect vision provider
- **WHEN** user selects "Auto" in the vision provider picker (value = "")
- **THEN** `vision_provider` is sent as empty string, backend stores `null`, and the provider is inferred from the model name at runtime

### Requirement: Image generation section manages image settings
The Image section SHALL allow toggling image generation, selecting provider/model, and configuring defaults (aspect ratio, size).

#### Scenario: Toggle image generation
- **WHEN** user toggles the image generation switch
- **THEN** system calls `/api/settings/image-generation/update?enabled=<bool>`

#### Scenario: Save image defaults
- **WHEN** user changes aspect ratio or model and clicks save
- **THEN** system persists changes via the image-generation update endpoint

### Requirement: Web section manages web search configuration
The Web section SHALL allow selecting search provider, entering API credentials, and configuring behavior (max results, timeout, Jina reader).

#### Scenario: Update web search provider
- **WHEN** user selects a different web search provider
- **THEN** system calls `/api/settings/web-search/update` with the new provider value

### Requirement: Apps section displays CLI apps and MCP presets
The Apps section SHALL display a catalog of CLI apps and MCP server presets. Users SHALL be able to install/uninstall CLI apps and enable/remove MCP presets.

#### Scenario: Install CLI app
- **WHEN** user clicks Install on a CLI app card
- **THEN** system calls `/api/settings/cli-apps/install?name=<app>` and shows progress

#### Scenario: Enable MCP preset
- **WHEN** user clicks Enable on an MCP preset
- **THEN** system calls `/api/settings/mcp-presets/enable?name=<preset>` and updates status

#### Scenario: Add custom MCP server
- **WHEN** user fills in custom MCP server form and submits
- **THEN** system calls `/api/settings/mcp-presets/custom` with the server configuration

### Requirement: Runtime section displays identity and system info
The Runtime section SHALL allow editing bot name, bot icon, and timezone. System info (config path, workspace, gateway, heartbeat) SHALL be displayed read-only.

#### Scenario: Update bot identity
- **WHEN** user changes bot_name and saves
- **THEN** system calls `/api/settings/update?bot_name=<value>`

### Requirement: Advanced section is read-only
The Advanced section SHALL display safety settings, integration counts, and exec configuration as read-only information.

#### Scenario: View advanced settings
- **WHEN** user navigates to Advanced section
- **THEN** all fields are rendered as read-only labels without edit controls

### Requirement: Restart banner on config change
When a settings update returns `requires_restart: true`, a restart banner SHALL appear at the top of the settings view. Clicking the restart button SHALL send `/restart` via the active WebSocket connection.

#### Scenario: Restart required after provider change
- **WHEN** user updates a provider API key and the response includes `requires_restart: true`
- **THEN** a banner appears: "Restart required for changes to take effect" with a Restart button

#### Scenario: User triggers restart
- **WHEN** user clicks the Restart button in the banner
- **THEN** a `/restart` slash command is sent over the WebSocket channel

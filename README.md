# Hex Light Card

A Home Assistant Lovelace custom card for setting a light (or light group)
color by **hex value** — either by typing a hex code or using a visual
picker. The current color is shown as a live swatch.

![preview](https://raw.githubusercontent.com/clsferguson/hex-light-card/main/preview.png)

## Features

- Binds to a single `light.` entity **or** a light group (group lights are
  reported with `supported_features` including RGB, so the card works with
  them as-is)
- Accepts `#RRGGBB` or `RRGGBB` (and 3-char `#RGB`) input
- **Validates hex input at commit** — the picker previews as you type, a
  partial value never shows an error, and an invalid value is flagged (and
  not applied) when you press Enter, leave the field, or move on
- **Typing-safe** — live HA state updates never clobber a value you're in
  the middle of typing, even if focus briefly leaves the field
- Shows the light's current color and hex value (an off light shows `off`)
- Optional brightness slider (sent with the color command **only while the
  light is on** — turning on an off light uses HA's remembered brightness)
- Works with any light that reports RGB support (`rgb_color` service data)
- Live state sync: the slider and current-color row follow external changes
  (voice, app, automations) without fighting your in-progress edits

## Installation

### Via HACS

1. Add this repository as a custom repository (category: **Lovelace**)
2. Search for **Hex Light Card** and install it
3. Reload the dashboard / clear browser cache

### Manual

Add the resource in **Settings → Dashboards → ⋮ → Resources**:

```
URL: https://<your-host>/hex-light-card.js?v=1.1.2
Type: JavaScript module
```

## Usage

### Standalone card

```yaml
type: custom:hex-light-card
entity: light.bedroom_strip
```

### As a Tile card feature

```yaml
type: tile
entity: light.bedroom_strip
features:
  - type: custom:hex-light-card-feature
```

### Options

| Name             | Type    | Required | Default | Description                                        |
| ---------------- | ------- | -------- | ------- | -------------------------------------------------- |
| `entity`         | string  | yes      | —       | A `light.` entity or light group                   |
| `title`          | string  | no       | light name | Card title                                     |
| `show_title`     | boolean | no       | `true`  | Show the title + state row (auto-off for the tile feature) |
| `show_current`   | boolean | no       | `true` (card) / `false` (tile feature) | Show the current color swatch + hex — the tile feature defaults this off (opt in with `show_current: true`) |
| `brightness`     | boolean | no       | `true`  | Show the brightness slider                         |
| `initial_brightness` | number | no     | light's value | Initial slider value if the light reports none |

### Example

```yaml
type: custom:hex-light-card
entity: light.bedroom_strip
title: Bedroom Color
brightness: true
```

## How it applies color

On commit (Enter, leaving the field, or picking a color) the card calls:

```
light.turn_on
  entity_id: <entity or list>
  rgb_color: [r, g, b]
  brightness: <if slider present AND the light is already on>
```

Hex → RGB conversion is exact (no rounding). For an **off** light no
brightness is sent, so HA restores the light's remembered brightness on
turn-on instead of forcing it on dim. If the light doesn't report RGB
support, the card shows a warning but will still attempt to apply.

## Versioning

The `CARD_VERSION` constant in the card's JS is kept in sync with the
release tag, and each version is published as a GitHub release — HACS uses
the release version (not the commit SHA) to report and update the card.

## License

MIT

# Design System Specification: The Zen Studio

## 1. Overview & Creative North Star
**Creative North Star: "The Digital Curator"**
This design system rejects the overstimulation of traditional gamification. We are moving away from "level-ups" and "gold coins" toward a high-end editorial experience that rewards progress through visual clarity and spatial harmony. The goal is to make the user feel like they are curate a high-end gallery of their own thoughts.

The "template" look is broken here through **Intentional Asymmetry**. Headers are often offset to the left with significant trailing whitespace, and content cards use varying vertical rhythm (Spacing 16 vs Spacing 20) to create a sense of breathing room. We treat the interface not as a software UI, but as a series of physical, premium paper stocks layered atop one another.

---

## 2. Colors
The palette is built on a foundation of "Atmospheric Whites." The primary teal (`#296767`) is used sparingly, acting as a "beacon" for progress rather than a decorative element.

### The "No-Line" Rule
**Explicit Instruction:** Do not use 1px solid borders to define sections. All structural separation must be achieved through background shifts. For example, a sidebar should use `surface_container_low` (`#f2f4f4`) against a `surface` (`#f9f9f9`) main workspace. High-contrast lines create visual "noise" that disrupts the Zen aesthetic.

### Surface Hierarchy & Nesting
Treat the UI as a series of stacked, semi-opaque sheets.
- **Base Layer:** `surface` (#f9f9f9)
- **Secondary Workspace:** `surface_container_low` (#f2f4f4)
- **Actionable Cards:** `surface_container_lowest` (#ffffff) to create a "pop" against the background.
- **Deep Modals:** `surface_container_high` (#e4e9ea).

### The "Glass & Gradient" Rule
To elevate the system above a generic flat UI, floating elements (like a progress summary or a floating action menu) must use **Glassmorphism**.
- **Style:** `surface_container_lowest` at 80% opacity with a `24px` backdrop-blur.
- **Signature Texture:** Use a subtle linear gradient on the Primary CTA (from `primary` #296767 to `primary_dim` #195b5b) at a 135-degree angle. This adds a "jewel-like" depth to the user's most important actions.

---

## 3. Typography
We utilize a dual-font strategy to balance character with utility. **Manrope** provides a geometric, modern authority for headings, while **Inter** ensures maximum legibility for the notebook's core content.

| Level | Font Family | Size | Weight / Usage |
| :--- | :--- | :--- | :--- |
| **Display-LG** | Manrope | 3.5rem | Light (300). For milestone celebrations. |
| **Headline-MD** | Manrope | 1.75rem | Medium (500). Main section titles. |
| **Title-LG** | Inter | 1.375rem | Semi-Bold (600). Entry headers. |
| **Body-LG** | Inter | 1rem | Regular (400). The primary writing experience. |
| **Label-MD** | Inter | 0.75rem | Medium (500). All-caps for metadata/progress. |

**Editorial Note:** Use `headline-sm` with a tracking of `-0.02em` and `label-md` with `+0.05em` letter spacing to create a high-end, bespoke typographic feel.

---

## 4. Elevation & Depth
Depth is a psychological cue for "focus." In this system, depth is quiet.

### The Layering Principle
Avoid "Drop Shadow" presets. Instead, use **Tonal Layering**. If a note card needs to stand out, place it (`surface_container_lowest`) on a `surface_container_low` background. The subtle shift from #f2f4f4 to #ffffff is enough to signal interactivity without cluttering the user's field of vision.

### Ambient Shadows
For floating elements (Modals/Popovers):
- **Shadow Token:** `0px 12px 32px rgba(45, 52, 53, 0.06)`
- Use a tint of `on_surface` (#2d3435) rather than pure black to ensure the shadow feels like a natural part of the environment.

### The "Ghost Border" Fallback
Where separation is strictly required for accessibility, use the **Ghost Border**:
- **Token:** `outline_variant` (#adb3b4) at **15% opacity**.
- **Corner Radius:** Follow the Scale `md` (0.375rem) for cards and `full` (9999px) for progress pills.

---

## 5. Components

### Buttons
- **Primary:** Gradient fill (`primary` to `primary_dim`), `on_primary` text, `full` roundedness. No shadow.
- **Secondary:** `surface_container_highest` fill, `on_surface` text.
- **Tertiary:** No fill. `primary` text. Underline on hover only.

### Progress Beacons (Gamification)
Instead of XP bars, use **Radial Progress Circles**.
- Use `primary` for the stroke and `primary_container` for the track.
- The stroke width should be thin (`2px`) to maintain the "Zen" aesthetic.

### Input Fields
- **Styling:** No bottom line or full border. Use `surface_container_low` as a subtle background fill. 
- **Focus State:** Transition background to `surface_container_lowest` and add a 1px `primary` ghost border (20% opacity).

### Cards & Lists
- **Strict Rule:** **No Dividers.** 
- Separate list items using `spacing-4` (1.4rem) of vertical whitespace. 
- Grouping is indicated by a very subtle background shift to `surface_container_lowest` for the entire group, rather than lines between items.

---

## 6. Do’s and Don’ts

### Do
- **Do** embrace "Over-spacing." If a layout feels tight, increase the spacing by two steps in the scale (e.g., move from `8` to `12`).
- **Do** use `primary_fixed_dim` for "inactive" but completed states to show history without drawing focus.
- **Do** align text-heavy content to a centered, narrow column (max-width 680px) to mimic an editorial manuscript.

### Don't
- **Don't** use pure black (#000) for text. Use `on_surface` (#2d3435) to keep the contrast soft and readable.
- **Don't** use "gaming" iconography (swords, trophies, stars). Use abstract geometric shapes or simple, thin-stroke UI icons.
- **Don't** use motion that is "bouncy." Use `cubic-bezier(0.2, 0.8, 0.2, 1)` for all transitions—this creates a "weighted," premium feel.

---

## 7. Scaling & Spacing
Consistency in spacing is the "invisible grid" that creates calm.
- **Standard Padding:** `spacing-6` (2rem).
- **Component Gap:** `spacing-3` (1rem).
- **Section Margin:** `spacing-16` (5.5rem). Use this to create distinct "Chapters" in the user's notebook.
## Design System — Zen Studio

All interactives must follow the Zen Studio design language.

### Colors

```
Primary:            #296767   (teal — accents, active states, primary buttons)
Primary hover:      #195b5b   (darker teal — hover, gradients)
On-primary text:    #d9fffe   (light text on primary backgrounds)
Surface:            #f9f9f9   (page background)
Surface-low:        #f2f4f4   (control panels, secondary areas)
Surface-lowest:     #ffffff   (cards, elevated surfaces)
Text primary:       #2d3435   (never use pure black)
Text secondary:     #5a6061   (labels, secondary text)
Borders:            #adb3b4   (use sparingly — prefer background shifts)
Success:            #d9f9df   (positive feedback backgrounds)
Error:              #9f403d   (error states)
```

### Typography

- Headings: `font-family: 'Segoe UI', system-ui, sans-serif; font-weight: 300–500`
- Body: `font-family: 'Inter', system-ui, sans-serif; font-size: 14px`
- Labels: `font-size: 10px; text-transform: uppercase; letter-spacing: 0.12em; font-weight: 700`
- Never use pure black (`#000`). Use `#2d3435` for text.

### Layout

- Page body: `background: #f9f9f9`
- Cards/panels: `background: #ffffff; border-radius: 12px` — no 1px borders, use background shifts.
- Primary buttons: `linear-gradient(135deg, #296767, #195b5b)` with `color: #d9fffe; border-radius: 999px`
- Shadows: `0px 12px 32px rgba(45, 52, 53, 0.06)` — subtle only.
- Spacing: generous padding (16–24px), section gaps (24–32px).
- Transitions: `cubic-bezier(0.2, 0.8, 0.2, 1)` for a premium feel.

### Interactive elements

- Control panels: `background: #f2f4f4`
- Active/selected items: `background: rgba(41, 103, 103, 0.08)` with `color: #296767`
- Progress bars: 3–4px height, `#296767` fill on `#f2f4f4` track
- State labels: 10px uppercase tracking
- Focus rings: `box-shadow: 0 0 0 2px rgba(41, 103, 103, 0.2)`

### Do NOT

- Use garish colors, heavy borders, or default browser styling.
- Use pure black text or backgrounds.
- Use heavy drop shadows.
- Use `#2962FF` or any non-Zen-Studio accent color.

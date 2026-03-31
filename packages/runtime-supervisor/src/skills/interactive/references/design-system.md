## Design System — Zen Studio (defaults)

These are default styles you can use when the student does not specify a visual direction. If the student asks for a specific look, color scheme, or design language, follow their lead instead.

### Default Colors

```
Primary:            #296767   (teal — accents, active states, primary buttons)
Primary hover:      #195b5b   (darker teal — hover, gradients)
On-primary text:    #d9fffe   (light text on primary backgrounds)
Surface:            #f9f9f9   (page background)
Surface-low:        #f2f4f4   (control panels, secondary areas)
Surface-lowest:     #ffffff   (cards, elevated surfaces)
Text primary:       #2d3435   (body text)
Text secondary:     #5a6061   (labels, secondary text)
Borders:            #adb3b4   (use sparingly — prefer background shifts)
Success:            #d9f9df   (positive feedback backgrounds)
Error:              #9f403d   (error states)
```

### Default Typography

- Headings: `font-family: 'Segoe UI', system-ui, sans-serif; font-weight: 300-500`
- Body: `font-family: 'Inter', system-ui, sans-serif; font-size: 14px`
- Labels: `font-size: 10px; text-transform: uppercase; letter-spacing: 0.12em; font-weight: 700`

### Default Layout

- Page body: `background: #f9f9f9`
- Cards/panels: `background: #ffffff; border-radius: 12px` — prefer background shifts over borders.
- Primary buttons: `linear-gradient(135deg, #296767, #195b5b)` with `color: #d9fffe; border-radius: 999px`
- Shadows: `0px 12px 32px rgba(45, 52, 53, 0.06)` — subtle only.
- Spacing: generous padding (16-24px), section gaps (24-32px).
- Transitions: `cubic-bezier(0.2, 0.8, 0.2, 1)` for a premium feel.

### Default Interactive Elements

- Control panels: `background: #f2f4f4`
- Active/selected items: `background: rgba(41, 103, 103, 0.08)` with `color: #296767`
- Progress bars: 3-4px height, `#296767` fill on `#f2f4f4` track
- Focus rings: `box-shadow: 0 0 0 2px rgba(41, 103, 103, 0.2)`

### General Tips

- Avoid default browser styling — even a minimal custom style is better.
- Prefer readable contrast ratios and consistent spacing.
- When in doubt, keep it clean and simple.

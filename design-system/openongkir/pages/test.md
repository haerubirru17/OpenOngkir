# Page Override — `/console` (Konsol OpenOngkir)

Overrides MASTER.md for this page only. Mode: **Operate** — the visitor
completes a task (check a shipping price, track a parcel, mint an API key).

## Structure (mobile-first, single column; desktop max 880px)

1. **Sticky top bar** — wordmark "OpenOngkir" (green square mark + name),
   live status pill (dot + "Live · v1.1.0", from `/v1/health`), link to API docs
   note in footer only. No nav menu — one page, one job.
2. **Intro** — one strong heading, one plain line explaining the product
   (own tariff database, harvested from official courier endpoints; prices are
   estimates). No eyebrow/kicker (banned), no hero metrics.
3. **API key strip** — compact. No key: primary action "Buat API key gratis"
   + collapsible paste field for an existing key. Key saved: masked state
   ("API key tersimpan") + "Lupakan". Created key shown once with copy button.
4. **Tool panel** — tab switch "Cek ongkir" / "Lacak resi" (real buttons,
   `aria-selected`, keyboard accessible). One tool visible at a time; the other
   is one tap away. Forms keep every current field and behavior.
5. **Results** — directly under the form. Cost results: list rows sorted by
   price ascending, cheapest tagged "Termurah"; each row shows courier,
   service, price (mono, tabular), ETA, source (DB/Live). Tracking: status
   headline + detail list + chronological timeline on a rail. Raw JSON stays
   in a collapsible `<details>` under each result. Errors render verbatim in
   `role="alert"` boxes, never swallowed.
6. **Status layanan** — collapsible `<details>` with the health stats
   (version, tariffs, wilayah, quote mix, uptime, last harvest). Auto-loads,
   no key needed.
7. **Footer** — one line: endpoints used + "Estimasi" disclaimer.

## Component notes

- Buttons: primary = solid green, min-height 48px on the main actions;
  secondary = 1px bordered. All touch targets ≥44px.
- Inputs/selects: 48px tall, 1px border, 8px radius, visible labels above
  every field; placeholder never replaces the label.
- Courier picker (cost form): toggle chips with `aria-pressed`, not bare
  checkboxes — same behavior, clearer affordance.
- Icons: inline SVG only, Lucide-style, stroke 2, round caps, one set.
  No emoji, no glyph icons.
- Motion: one authored moment — results fade/slide in (200ms ease-out).
  `prefers-reduced-motion` disables it. Loading state on submit buttons
  (spinner + "Memuat…"), never a silent click.
- Browser surfaces: themed selection color, visible focus ring (2px green,
  offset 2px), tabular numerals for all figures.

## Constraints

- Single self-contained file (`public/test.html`): HTML+CSS+JS inline, no
  external JS library. Google Fonts link allowed with system-font fallback;
  page must render correctly with no CDN.
- Route: `GET /console` (`GET /test` redirect 301 ke `/console`). No API/endpoint changes.

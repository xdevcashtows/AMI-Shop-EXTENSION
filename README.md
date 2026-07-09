# AMI Parts Bridge Extension

Floating browser widget that mirrors an O'Reilly FirstCall / Pro quote cart and transfers selected parts into an **AMI Shop CRM** job card.

The widget is **not** a Chrome side panel — it floats over the page, can be dragged, collapsed, or closed, and remembers its position.

## Install (Chrome / Edge)

1. Open `chrome://extensions` (or `edge://extensions`).
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder: `AMI Shop Extension`
5. Click **Reload** on the extension after updates.

## Use

1. Run AMI Shop CRM (`npm run dev:all`).
2. Open a job card → **Order from O'Reilly**.
3. FirstCall opens; the floating **AMI Parts Bridge** widget appears **only on the O'Reilly / FirstCall page** (not in AMI CRM).
4. Drag the navy title bar to move it. Drag any edge/corner to resize. Use **▾** to collapse, **✕** to hide.
5. Shop / build a quote. Use **Copy VIN** / **Fill VIN** as needed.
6. Click **Transfer to Job Card**, then confirm import back in AMI.

Click the extension toolbar icon anytime to toggle the widget on the current tab.

### Verify without scraping

In the widget, click **Add test** → **Transfer to Job Card**.

## Project layout

```
background.js                 Session storage + transfer POST
content/crm-bridge.js         CRM session handoff + extension ping
content/oreilly-cart.js       FirstCall cart mirror + VIN fill
content/floating-widget.js    Draggable floating host + iframe
widget/                       Widget UI (loaded inside the iframe)
icons/
```

## Notes

- Position is saved in extension storage.
- API base URL defaults to `http://localhost:8787` (editable under API settings in the widget).
- NAPA cart scraping is not included yet (CRM button/session stub only).

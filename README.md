# AMI Parts Bridge Extension

Chrome **side panel** that mirrors an O'Reilly FirstCall or NAPA ProLink cart and transfers selected parts into an **AMI Shop CRM** job card.

The UI lives in Chrome's native side panel beside the page -- it does **not** overlay or cover the supplier site.

## Install (Chrome / Edge)

1. Open `chrome://extensions` (or `edge://extensions`).
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder: `AMI Shop Extension`
5. Click **Reload** on the extension after updates.

## Use

1. Run AMI Shop CRM (`npm run dev:all`) or use production shop.
2. Open a job card -> **Order from O'Reilly** or **Order from NAPA**.
3. The supplier site opens; the **AMI Parts Bridge** side panel opens beside it (or click the toolbar icon).
4. Collapse/close the panel with Chrome's side panel controls -- the supplier page stays fully visible.
5. Shop / build a quote. Use **Copy VIN** / **Fill VIN** as needed.
6. Click **Transfer to Job Card** -- parts are imported into AMI automatically.

### Verify without scraping

If your panel build includes **Add test**, use that then **Transfer to Job Card**. Otherwise add a real part on the supplier site and transfer.

## Project layout

```
background.js                 Session storage + transfer POST + side panel open
sidepanel/                    Side panel UI (reuses widget assets)
content/crm-bridge.js         CRM session handoff + extension ping
content/supplier-bridge.js    Hash handshake + Fill VIN / scrape relay
content/oreilly-cart.js       FirstCall cart mirror + VIN fill
content/napa-cart.js          NAPA ProLink cart mirror + VIN fill
content/napa-hash-strip.js    Early NAPA #ami-bridge strip
content/page-network-hook.js  Page-world fetch/XHR intercept
widget/                       Shared panel UI assets
icons/
```

## Notes

- API base URL can be set in extension storage (`amiPartsBridgeSettings.apiBaseUrl`); default is `http://localhost:8787`.
- NAPA cart sync watches ProLink `atc` / `getMiniCart` / cart `entries` APIs.
- Toolbar icon opens/closes the Chrome side panel.

# Closet

A personal clothing catalog for iPhone: photos, details, filters, wear logging and cost per wear.
Data is stored on the device (IndexedDB); use the Archive tab to export a backup.

Open https://clmeranus.github.io/closet/ in Safari → Share → Add to Home Screen.

## Online search + AI autofill
When adding a piece, **Find it online** searches for garment photos and uses AI to fill in the details.
It needs a small free server; see [worker/SETUP.md](worker/SETUP.md).

## Background removal
When adding or editing a piece, **Remove background** cuts the garment out onto a clean white background.
It runs on the phone using IMG.LY's open-source background-removal model (about 40 MB, downloaded the first time).

## Add from a product link
Paste a link to an item in the add form and tap **Import**. The search server reads the page for photos, price, colour and available sizes
(Shopify stores and sites with standard product data work best), AI fills in the rest, and you tap the size you own.
If a store blocks it, the app works from the link text and finds photos by search instead.
**After this update, re-paste `worker/worker.js` into your Cloudflare worker and click Deploy.**

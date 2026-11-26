# Setting up online search + AI autofill

Closet needs a tiny server to search for garment photos and run the AI, so your API keys never sit on your phone or in this public repo. It runs free on Cloudflare. Allow about 15 minutes; a laptop is easier than a phone for this part.

## 1. Brave Search key (garment photo search)
1. Go to **https://brave.com/search/api** and sign up.
2. Choose the **Search** plan. It includes $5 of free credit every month, which covers about 1,000 searches. Brave asks for a card to verify you; it isn't charged unless you go over the free credit.
3. Open **API Keys** in the dashboard, create a key, and copy it.

## 2. Anthropic key (AI autofill)
1. Go to **https://console.anthropic.com** and sign up.
2. Under **Billing**, add a small amount of credit (the minimum is fine). Each autofill uses Claude Haiku and costs well under a cent.
3. Under **API Keys**, create a key and copy it.

## 3. Cloudflare Worker (the server)
1. Sign up free at **https://dash.cloudflare.com**.
2. Go to **Workers & Pages → Create → Create Worker** (start from "Hello World"). Name it `closet-search` and click **Deploy**.
3. Click **Edit code**, delete everything, and paste in the contents of [`worker.js`](worker.js) from this folder. Click **Deploy**.
4. Go to the worker's **Settings → Variables and Secrets** and add three entries, each with type **Secret**:
   | Name | Value |
   |---|---|
   | `BRAVE_KEY` | your Brave key |
   | `ANTHROPIC_KEY` | your Anthropic key |
   | `APP_TOKEN` | a passcode you make up, e.g. `velvet-coat-1987` |
5. Copy the worker's address. It looks like `https://closet-search.<your-name>.workers.dev`.

## 4. Connect the app
In Closet, open the **Archive** tab. Under **Online search**, paste the worker address and your `APP_TOKEN` passcode, then tap **Save & test**. It should say *"Search and AI autofill are ready."*

Then, when you add a piece, tap **Find it online**, search (brand + item works best) and tap a photo. AI fills in the name, brand, category, colours, seasons and tags; check them before saving.

### Notes
- The worker only answers requests from `https://clmeranus.github.io` that carry your passcode.
- The AI only fills in fields that are still empty, so anything you've already typed is kept.
- Photos are saved into the app, so they still show offline.

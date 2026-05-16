# First-Time Setup & Deploy Checklist

Follow these steps once to establish the deploy pipeline.
After that, every push to `main` ships automatically.

---

## 1. Local setup (one time)

```bash
cd "Bikepacking Ap"
npm install          # installs Vite, Biome, Vitest, vite-plugin-pwa
npm run dev          # open http://localhost:5173 — hot reload
```

---

## 2. Run CI locally before every push

This is the exact same sequence GitHub Actions runs. Muscle memory: **check → test → build**.

```bash
npm run check        # Biome: lint + format check
npm test             # Vitest: runs all tests in src/tests/
npm run build        # Vite: outputs to dist/
```

Fix anything that fails before pushing. CI will block the deploy if any step fails.

To auto-fix formatting:
```bash
npm run format       # Biome rewrites files in-place
```

---

## 3. Create the GitHub repo

```bash
git init
git add .
git commit -m "feat: initial PWA scaffold — app shell, CI/CD, Cloudflare Pages"
# Create a new repo on github.com (no README, no .gitignore — we have both)
git remote add origin https://github.com/YOUR_USERNAME/bikepacker-navigator.git
git branch -M main
git push -u origin main
```

---

## 4. Create the Cloudflare Pages project (one time)

1. Go to https://dash.cloudflare.com → **Workers & Pages** → **Create application** → **Pages**
2. Click **"Connect to Git"** → authorize GitHub → select your `bikepacker-navigator` repo
3. Set:
   - **Framework preset:** None (or Vite)
   - **Build command:** `npm run build`
   - **Build output directory:** `dist`
4. Click **Save and Deploy** — this first deploy runs from the Cloudflare UI

After this, all subsequent deploys happen automatically via GitHub Actions.

---

## 5. Add GitHub Secrets for automated deploys

In your GitHub repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**:

| Secret name | Where to find the value |
|-------------|------------------------|
| `CLOUDFLARE_API_TOKEN` | Cloudflare dashboard → My Profile → API Tokens → Create Token → use **"Edit Cloudflare Workers"** template, then add **Pages:Edit** permission |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare dashboard → right sidebar on the main page — a 32-char hex string |

Once both secrets are set, every push to `main` will:
1. Run lint + tests + build (CI job)
2. If CI passes → deploy to Cloudflare Pages (deploy job)
3. GitHub will show a ✅ deployment status on the commit

---

## 6. Verify the pipeline end-to-end

```bash
# Make a trivial change to confirm the loop works
echo "# test" >> README.md
git add README.md
git commit -m "chore: verify CI/CD pipeline"
git push
```

Watch the Actions tab in GitHub. You should see:
- `Lint → Test → Build` pass in ~60 seconds
- `Deploy → Cloudflare Pages` attach a preview URL to the commit

---

## Daily workflow after setup

```
write code → npm run check → npm test → git commit → git push → done
```

CI/CD handles the rest. You'll get a Cloudflare Pages URL on every merge to main.

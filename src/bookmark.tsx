import React, { useEffect, useMemo, useState } from 'react';
import { List, ActionPanel, Action, Icon, showToast, getPreferenceValues } from '@vicinae/api';
import { homedir } from 'os';
import path from 'path';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { execFile } from 'child_process';

type Bookmark = {
  id: number;
  title: string;
  url: string;
  icon_url?: string | null;
};

function expandUserPath(p?: string | null): string | null {
  if (!p) return null;
  let out = p.trim();
  // Strip surrounding quotes
  if ((out.startsWith('"') && out.endsWith('"')) || (out.startsWith("'") && out.endsWith("'"))) {
    out = out.slice(1, -1);
  }
  if (out.startsWith('~')) {
    const home = homedir();
    if (out === '~') out = home;
    else if (out.startsWith('~/')) out = path.join(home, out.slice(2));
  }
  // Basic env expansion for HOME
  out = out.replace('${HOME}', homedir()).replace('$HOME', homedir());
  return out;
}

function sqlEscapeSingleQuotes(s: string): string {
  return s.split("'").join("''");
}

function execSqlite(jsonQuery: string, dbPath: string, attached?: { name: string; path: string }[]): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const args: string[] = ['-json'];
    if (attached && attached.length > 0) {
      // We will pass all in a single SQL script string
    }
    args.push(dbPath);
    const sqlParts: string[] = [];
    for (const a of attached ?? []) {
      sqlParts.push(`ATTACH DATABASE '${sqlEscapeSingleQuotes(a.path)}' AS ${a.name};`);
    }
    sqlParts.push(jsonQuery);
    const sql = sqlParts.join(' ');
    execFile('sqlite3', args.concat([sql]), { maxBuffer: 10_000_000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      try {
        const data = stdout?.trim() ? JSON.parse(stdout) : [];
        resolve(data);
      } catch (e) {
        reject(e);
      }
    });
  });
}

async function findZenProfileRoot(): Promise<string | null> {
  const candidates = [
    path.join(homedir(), '.var', 'app', 'app.zen_browser.zen', '.zen'),
    path.join(homedir(), '.zen'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

async function getDefaultZenProfileDir(zenRoot: string): Promise<string | null> {
  const profilesIni = path.join(zenRoot, 'profiles.ini');
  try {
    const content = await fs.readFile(profilesIni, 'utf8');
    const blocks = content.split(/\n\n+/);
    let chosenPath: string | null = null;
    for (const blk of blocks) {
      if (!/\[Profile/.test(blk)) continue;
      const isDefault = /\nDefault=1\b/.test(blk);
      const pathMatch = blk.match(/\nPath=(.+)/);
      if (!pathMatch) continue;
      const rel = pathMatch[1].trim();
      const full = path.join(zenRoot, rel);
      if (isDefault) return full;
      if (!chosenPath) chosenPath = full;
    }
    return chosenPath;
  } catch {
    return null;
  }
}

function domainFromUrl(u: string): string | null {
  try {
    const { hostname } = new URL(u);
    return hostname;
  } catch {
    return null;
  }
}

async function copyForRead(src: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'vicinae-zen-'));
  const dst = path.join(dir, path.basename(src));
  await fs.copyFile(src, dst);
  return dst;
}

type Preferences = {
  placesPath?: string;
};

export default function ZenBookmarks() {
  const [items, setItems] = useState<Bookmark[]>([]);
  const [isLoading, setLoading] = useState(true);
  const [zenAppId, setZenAppId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Try to resolve Zen app id dynamically from installed apps
        try {
          const { getApplications } = await import('@vicinae/api');
          const apps = await getApplications('https://example.com');
          const zen = apps.find(a => /zen/i.test(a.name) || /zen_browser/i.test(a.id));
          if (zen) setZenAppId(zen.id);
        } catch {
          // ignore, fallback to known Flatpak desktop id
          setZenAppId('app.zen_browser.zen.desktop');
        }

        // Preferences: allow user-specified places.sqlite path
        const prefs = getPreferenceValues<Preferences>();
        let placesCandidate = expandUserPath(prefs.placesPath);
        if (placesCandidate) {
          try {
            const st = await fs.stat(placesCandidate);
            if (st.isDirectory()) {
              const dirCandidate = path.join(placesCandidate, 'places.sqlite');
              if (existsSync(dirCandidate)) placesCandidate = dirCandidate;
            }
          } catch {
            // ignore; we handle not found below
          }
        }

        let places: string | null = null;
        let favicons: string | null = null;
        if (placesCandidate && existsSync(placesCandidate)) {
          places = placesCandidate;
          const dir = path.dirname(placesCandidate);
          const fav = path.join(dir, 'favicons.sqlite');
          favicons = existsSync(fav) ? fav : null;
        } else {
          // Fallback to autodetection
          const zenRoot = await findZenProfileRoot();
          if (zenRoot) {
            const profile = await getDefaultZenProfileDir(zenRoot);
            if (profile) {
              const p = path.join(profile, 'places.sqlite');
              const f = path.join(profile, 'favicons.sqlite');
              if (existsSync(p)) places = p;
              if (existsSync(f)) favicons = f;
            }
          }
        }

        if (!places) {
          throw new Error('places.sqlite not found. Set the "Zen places.sqlite Path" preference to your file.');
        }

        // copy to temp to avoid DB lock issues
        const tmpPlaces = await copyForRead(places);
        let rows: any[] = [];
        if (favicons && existsSync(favicons)) {
          const tmpFavicons = await copyForRead(favicons);
          const query = `
            SELECT b.id as id,
                   COALESCE(NULLIF(TRIM(b.title), ''), NULLIF(TRIM(p.title), ''), p.url) as title,
                   p.url as url,
                   (
                     SELECT fi.icon_url
                     FROM fav.moz_pages_w_icons f_pwi
                     JOIN fav.moz_icons_to_pages f_itp ON f_itp.page_id = f_pwi.id
                     JOIN fav.moz_icons fi ON fi.id = f_itp.icon_id
                     WHERE f_pwi.page_url = p.url
                     ORDER BY fi.width DESC
                     LIMIT 1
                   ) as icon_url
            FROM moz_bookmarks b
            JOIN moz_places p ON b.fk = p.id
            WHERE b.type = 1 AND p.url LIKE 'http%'
            ORDER BY b.dateAdded DESC
            LIMIT 500;
          `;
          rows = await execSqlite(query, tmpPlaces, [{ name: 'fav', path: tmpFavicons }]);
        } else {
          const query = `
            SELECT b.id as id,
                   COALESCE(NULLIF(TRIM(b.title), ''), NULLIF(TRIM(p.title), ''), p.url) as title,
                   p.url as url,
                   NULL as icon_url
            FROM moz_bookmarks b
            JOIN moz_places p ON b.fk = p.id
            WHERE b.type = 1 AND p.url LIKE 'http%'
            ORDER BY b.dateAdded DESC
            LIMIT 500;
          `;
          rows = await execSqlite(query, tmpPlaces);
        }
        const parsed: Bookmark[] = rows.map((r) => ({
          id: Number(r.id),
          title: String(r.title ?? r.url ?? ''),
          url: String(r.url ?? ''),
          icon_url: r.icon_url ?? null,
        })).filter((r) => r.url);

        if (!cancelled) setItems(parsed);
      } catch (e: any) {
        console.error(e);
        const msg = e?.message ?? 'Failed to load Zen bookmarks';
        setError(msg);
        showToast({ title: msg });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const sections = useMemo(() => {
    // Group by domain for a nicer layout
    const byDomain = new Map<string, Bookmark[]>();
    for (const it of items) {
      const d = domainFromUrl(it.url) ?? 'Other';
      const list = byDomain.get(d) ?? [];
      list.push(it);
      byDomain.set(d, list);
    }
    // Sort domains alphabetically
    return Array.from(byDomain.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [items]);

  return (
    <List isLoading={isLoading} filtering searchBarPlaceholder="Search Zen bookmarks…">
      {error && (
        <List.EmptyView title="Unable to load Zen bookmarks" description={error} icon={Icon.ExclamationMark} />
      )}
      {!error && sections.map(([domain, bookmarks]) => (
        <List.Section key={domain} title={domain}>
          {bookmarks.map((b) => (
            <List.Item
              key={b.id.toString()}
              title={b.title}
              subtitle={b.url}
              keywords={[domain, ...(b.title?.split(/\s+/) ?? [])]}
              icon={b.icon_url || (domain ? `https://www.google.com/s2/favicons?sz=64&domain_url=${encodeURIComponent(b.url)}` : Icon.Globe)}
              actions={
                <ActionPanel>
                  {zenAppId ? (
                    <Action.Open title="Open in Zen" target={b.url} app={zenAppId} />
                  ) : (
                    <Action.OpenInBrowser title="Open in Browser" url={b.url} />
                  )}
                  <Action.OpenInBrowser title="Open in Default Browser" url={b.url} />
                  <Action.CopyToClipboard title="Copy URL" content={b.url} />
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      ))}
    </List>
  );
}

/**
 * hosted·ai Sales Order — Worker
 *
 * KV namespace bindings required:
 *   ORDER_COUNTER  — auto-increment counter
 *   ORDERS         — order records
 *
 * Secrets (set via wrangler secret put):
 *   API_KEY           — password for the sales order app
 *   PIPEDRIVE_TOKEN   — your Pipedrive API token
 *   PIPEDRIVE_DOMAIN  — your Pipedrive company domain (e.g. "mycompany")
 *
 * Deploy steps:
 *   1. wrangler kv:namespace create ORDER_COUNTER
 *   2. wrangler kv:namespace create ORDERS
 *   3. Paste both ids into wrangler.toml
 *   4. wrangler secret put API_KEY
 *   5. wrangler secret put PIPEDRIVE_TOKEN
 *   6. wrangler secret put PIPEDRIVE_DOMAIN   (just "mycompany", not the full URL)
 *   7. wrangler deploy
 *
 * Endpoints:
 *   POST   /next              → increment counter
 *   GET    /peek              → read counter
 *   PUT    /seed              → set counter manually
 *   POST   /orders            → save order + sync to Pipedrive
 *   GET    /orders            → list all orders
 *   GET    /orders/:id        → fetch single order
 *   PUT    /orders/:id        → update order + sync to Pipedrive
 *   POST   /reset            → wipe all orders + reset counter (body: { orders, counter, counter_seed })
 */

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const COUNTER_KEY = 'order_counter';
const KV_SEED     = 327;

export default {
  async fetch(request, env) {

    if (request.method === 'OPTIONS')
      return new Response(null, { status: 204, headers: CORS });

    // ── Public endpoints (no auth required) ──────────────────────────────────
    const urlObj   = new URL(request.url);
    const pubParts = urlObj.pathname.replace(/^\/|\/$/g, '').split('/');

    // GET /so-number — public: fetch current SalesOrderNumber from KV
    if (pubParts[0] === 'so-number' && request.method === 'GET') {
      const raw = await env.ORDER_COUNTER.get('so_number');
      if (raw === null) return json({ order_number: null });
      return json({ order_number: parseInt(raw, 10) });
    }

    // POST /generate-pdf — public: generate PDF from order data and return bytes
    if (pubParts[0] === 'generate-pdf' && request.method === 'POST') {
      try {
        const order  = await request.json().catch(() => ({}));
        const mlaUrl         = (await env.ORDER_COUNTER.get('mla_url')) || 'https://hosted.ai/legal/Master_License_Agreement_v0.01.pdf';
        const terminationTxt = (await env.ORDER_COUNTER.get('termination_text')) || '';
        const result = await generatePdf({ ...order, mla_url: mlaUrl, termination_text: terminationTxt }, env);
        if (!result.pdfBytes) return json({ error: 'PDF generation failed', log: result.log }, 500);
        return new Response(result.pdfBytes, {
          status: 200,
          headers: {
            ...CORS,
            'Content-Type':        'application/pdf',
            'Content-Disposition': `attachment; filename="Sales_Order_${order.order_number || 'draft'}.pdf"`,
          },
        });
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    // GET /mla-url — public
    if (pubParts[0] === 'mla-url' && request.method === 'GET') {
      const raw = await env.ORDER_COUNTER.get('mla_url');
      return json({ url: raw || 'https://hosted.ai/legal/Master_License_Agreement_v0.01.pdf' });
    }

    if (pubParts[0] === 'termination-text' && request.method === 'GET') {
      const raw = await env.ORDER_COUNTER.get('termination_text');
      return json({ text: raw || '' });
    }

    // GET /org-so?name=... — public: fetch current SalesOrderNumber for an org (no increment)
    if (pubParts[0] === 'org-so' && request.method === 'GET') {
      if (!env.PIPEDRIVE_TOKEN || !env.PIPEDRIVE_DOMAIN)
        return json({ order_number: null });
      const base = `https://${env.PIPEDRIVE_DOMAIN}.pipedrive.com/api/v1`;
      const qs   = `api_token=${env.PIPEDRIVE_TOKEN}`;
      const name = urlObj.searchParams.get('name');
      if (!name) return json({ order_number: null });
      try {
        const search  = await pdFetch(`${base}/organizations/search?term=${encodeURIComponent(name)}&exact_match=true&${qs}`);
        const org     = search?.data?.items?.[0]?.item;
        if (!org) return json({ order_number: null, org_id: null });
        const orgData = await pdFetch(`${base}/organizations/${org.id}?${qs}`);
        const raw     = orgData?.data?.['b3cf4034d1e45135ee2384f0914c7a993a1b148b'];
        const current = parseInt(typeof raw === 'object' ? raw?.value ?? raw : raw, 10);
        return json({ order_number: isNaN(current) ? null : current, org_id: org.id });
      } catch (e) {
        return json({ order_number: null, error: e.message });
      }
    }

    // ── Auth ──────────────────────────────────────────────────────────────────
    const token = (request.headers.get('Authorization') || '').replace('Bearer ', '');
    // Check runtime override first (set via /change-password), fall back to deploy-time secret
    const runtimeKey = await env.ORDER_COUNTER.get('runtime_api_key');
    const validKey   = runtimeKey || env.API_KEY;
    if (!validKey || token !== validKey)
      return json({ error: 'Unauthorized' }, 401);

    const url      = new URL(request.url);
    const parts    = url.pathname.replace(/^\/|\/$/g, '').split('/');
    const resource = parts[0];
    const id       = parts[1];

    try {

      // ── Counter ───────────────────────────────────────────────────────────
      if (resource === 'next' && request.method === 'POST') {
        const raw  = await env.ORDER_COUNTER.get(COUNTER_KEY);
        const next = (raw !== null ? parseInt(raw, 10) : KV_SEED) + 1;
        await env.ORDER_COUNTER.put(COUNTER_KEY, String(next));
        return json({ order_number: next });
      }

      if (resource === 'peek' && request.method === 'GET') {
        const raw = await env.ORDER_COUNTER.get(COUNTER_KEY);
        return json({ order_number: raw !== null ? parseInt(raw, 10) : KV_SEED });
      }

      if (resource === 'seed' && request.method === 'PUT') {
        const body  = await request.json().catch(() => ({}));
        const value = parseInt(body.value, 10);
        if (isNaN(value) || value < 1)
          return json({ error: 'value must be a positive integer' }, 400);
        await env.ORDER_COUNTER.put(COUNTER_KEY, String(value));
        return json({ order_number: value, message: 'Counter updated.' });
      }

      // ── Orders ────────────────────────────────────────────────────────────

      // POST /orders — create
      if (resource === 'orders' && !id && request.method === 'POST') {
        const order = await request.json();
        if (!order.order_number)
          return json({ error: 'order_number is required' }, 400);

        const key      = `order:${order.order_number}`;
        const existing = await env.ORDERS.get(key);
        if (existing)
          return json({ error: `Order ${order.order_number} already exists. Use PUT to update.` }, 409);

        const record = { ...order, saved_at: now(), updated_at: now() };

        // Sync to Pipedrive — strip large blobs to avoid payload issues
        const orderForPd = { ...record };
        delete orderForPd.sig_vendor;
        delete orderForPd.sig_customer;
        const pd = await syncToPipedrive(orderForPd, env);
        if (pd.deal_id) record.pipedrive_deal_id = pd.deal_id;

        await env.ORDERS.put(key, JSON.stringify(record), { metadata: meta(record) });

        // Increment global order number counter after successful save
        const soRaw  = await env.ORDER_COUNTER.get('so_number');
        const soNext = (soRaw !== null ? parseInt(soRaw, 10) : parseInt(order.order_number, 10) || 0) + 1;
        await env.ORDER_COUNTER.put('so_number', String(soNext));

        return json({
          success:      true,
          order_number: order.order_number,
          saved_at:     record.saved_at,
          pipedrive:    pd,
        }, 201);
      }

      // GET /orders — list
      if (resource === 'orders' && !id && request.method === 'GET') {
        const list   = await env.ORDERS.list({ prefix: 'order:' });
        const orders = list.keys
          .map(k => ({ ...k.metadata, key: k.name }))
          .sort((a, b) => (b.order_number || 0) - (a.order_number || 0));
        return json({ orders, total: orders.length });
      }

      // GET /orders/:id — fetch
      if (resource === 'orders' && id && request.method === 'GET') {
        const raw = await env.ORDERS.get(`order:${id}`);
        if (!raw) return json({ error: `Order ${id} not found` }, 404);
        return json(JSON.parse(raw));
      }

      // PUT /orders/:id — update
      if (resource === 'orders' && id && request.method === 'PUT') {
        const key      = `order:${id}`;
        const existing = await env.ORDERS.get(key);
        if (!existing) return json({ error: `Order ${id} not found` }, 404);

        const updates = await request.json();
        const record  = {
          ...JSON.parse(existing),
          ...updates,
          order_number: id,
          updated_at:   now(),
        };

        // Sync update to Pipedrive — strip large blobs
        const orderForPd2 = { ...record };
        delete orderForPd2.sig_vendor;
        delete orderForPd2.sig_customer;
        const pd = await syncToPipedrive(orderForPd2, env);
        if (pd.deal_id) record.pipedrive_deal_id = pd.deal_id;

        await env.ORDERS.put(key, JSON.stringify(record), { metadata: meta(record) });
        return json({ success: true, order_number: id, updated_at: record.updated_at, pipedrive: pd });
      }

      // DELETE /orders/:id
      if (resource === 'orders' && id && request.method === 'DELETE') {
        const key      = `order:${id}`;
        const existing = await env.ORDERS.get(key);
        if (!existing) return json({ error: `Order ${id} not found` }, 404);
        await env.ORDERS.delete(key);
        return json({ success: true, deleted: id });
      }

      // POST /change-password — store new password in KV (requires wrangler secret put to persist across deploys)
      if (resource === 'change-password' && request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const newPw = (body.new_password || '').trim();
        if (!newPw || newPw.length < 8)
          return json({ error: 'Password must be at least 8 characters' }, 400);
        // Store in KV as a runtime override — worker will check this first on next auth
        await env.ORDER_COUNTER.put('runtime_api_key', newPw);
        return json({ success: true, message: 'Password updated in KV. Run "wrangler secret put API_KEY" to make it permanent.' });
      }

      // GET /orgs — return all Pipedrive organizations for autocomplete
      // Supports ?search=term to search directly instead of paginating
      if (resource === 'orgs' && request.method === 'GET') {
        if (!env.PIPEDRIVE_TOKEN || !env.PIPEDRIVE_DOMAIN)
          return json({ orgs: [], reason: 'Pipedrive not configured' });

        const base   = `https://${env.PIPEDRIVE_DOMAIN}.pipedrive.com/api/v1`;
        const qs     = `api_token=${env.PIPEDRIVE_TOKEN}`;
        const search = urlObj.searchParams.get('search');

        // If search term provided, use Pipedrive search API directly
        if (search && search.length >= 2) {
          const res   = await pdFetch(`${base}/organizations/search?term=${encodeURIComponent(search)}&limit=20&${qs}`);
          const items = res?.data?.items || [];
          const orgs  = items.map(i => ({
            id:                 i.item.id,
            name:               i.item.name,
            address:            i.item.address || '',
            tech_contact_email: pdField(i.item['317666d2e216abb25f07e94bde73f0aefe5039d8']),
            tech_contact_phone: pdField(i.item['c928bc395d5bfb04addd3d3a8af45b670e75ceb4']),
            billing_email:      pdField(i.item['e6ff39caec53c7f8168d8746086e30048b9f755a']),
            billing_phone:      pdField(i.item['d3289881a78247f814a1233944f52cf1d68a1e4e']),
          }));
          return json({ orgs, total: orgs.length, source: 'search' });
        }

        // Otherwise paginate for the initial full list (capped at 200 to avoid timeout)
        let orgs = [], start = 0, more = true;
        while (more && orgs.length < 200) {
          const res   = await pdFetch(`${base}/organizations?limit=100&start=${start}&${qs}`);
          const items = res?.data || [];
          if (!items.length) break;

          orgs.push(...items.map(o => ({
            id:                 o.id,
            name:               o.name,
            address:            o.address || '',
            tech_contact_email: pdField(o['317666d2e216abb25f07e94bde73f0aefe5039d8']),
            tech_contact_phone: pdField(o['c928bc395d5bfb04addd3d3a8af45b670e75ceb4']),
            billing_email:      pdField(o['e6ff39caec53c7f8168d8746086e30048b9f755a']),
            billing_phone:      pdField(o['d3289881a78247f814a1233944f52cf1d68a1e4e']),
          })));

          more  = res?.additional_data?.pagination?.more_items_in_collection || false;
          start = res?.additional_data?.pagination?.next_start || start + 100;
        }

        orgs.sort((a, b) => a.name.localeCompare(b.name));
        return json({ orgs, total: orgs.length, source: 'paginate' });
      }

      // GET /org-persons?id=... — fetch persons for a specific org (called after selection)
      if (resource === 'org-persons' && request.method === 'GET') {
        if (!env.PIPEDRIVE_TOKEN || !env.PIPEDRIVE_DOMAIN)
          return json({ persons: [] });

        const base  = `https://${env.PIPEDRIVE_DOMAIN}.pipedrive.com/api/v1`;
        const qs    = `api_token=${env.PIPEDRIVE_TOKEN}`;
        const orgId = url.searchParams.get('id');
        if (!orgId) return json({ persons: [] });

        const orgRes  = await pdFetch(`${base}/organizations/${orgId}?${qs}`);
        const orgData = orgRes?.data || {};

        const res     = await pdFetch(`${base}/organizations/${orgId}/persons?limit=5&${qs}`);
        const persons = (res?.data || []).map(p => ({
          name:  p.name  || '',
          email: p.email?.[0]?.value || '',
          phone: p.phone?.[0]?.value || '',
        }));
        // Resolve person-type custom fields (Pipedrive returns person ID as integer)
        const resolvePerson = async (val) => {
          const id = typeof val === 'object' ? val?.value : val;
          if (!id || typeof id !== 'number') return pdField(val);
          try {
            const p = await pdFetch(`${base}/persons/${id}?${qs}`);
            return p?.data?.name || '';
          } catch (e) { return ''; }
        };

        const [techName, billingName] = await Promise.all([
          resolvePerson(orgData['88cbe1f7ae31f61d5e4f24abce8ecaab9e741e80']),
          resolvePerson(orgData['877ec40425de5ce0bd5b18548d43f3f69c024d48']),
        ]);

        return json({
          persons,
          tech_contact_name:  techName,
          tech_contact_email: pdField(orgData['317666d2e216abb25f07e94bde73f0aefe5039d8']),
          tech_contact_phone: pdField(orgData['c928bc395d5bfb04addd3d3a8af45b670e75ceb4']),
          billing_contact:    billingName,
          billing_email:      pdField(orgData['e6ff39caec53c7f8168d8746086e30048b9f755a']),
          billing_phone:      pdField(orgData['d3289881a78247f814a1233944f52cf1d68a1e4e']),
        });
      }

      // GET /lookup-org?name=... — find org and latest deal ID by company name
      if (resource === 'lookup-org' && request.method === 'GET') {
        if (!env.PIPEDRIVE_TOKEN || !env.PIPEDRIVE_DOMAIN)
          return json({ deal_id: null, org_id: null, reason: 'Pipedrive not configured' });

        const name = url.searchParams.get('name');
        if (!name) return json({ deal_id: null, org_id: null, reason: 'No name provided' });

        const base = `https://${env.PIPEDRIVE_DOMAIN}.pipedrive.com/api/v1`;
        const qs   = `api_token=${env.PIPEDRIVE_TOKEN}`;

        // Search org by exact name
        const orgSearch = await pdFetch(
          `${base}/organizations/search?term=${encodeURIComponent(name)}&exact_match=true&${qs}`
        );
        const org = orgSearch?.data?.items?.[0]?.item;
        if (!org) return json({ deal_id: null, org_id: null, reason: 'No matching organization' });

        // Get most recent deal for this org
        const dealsRes = await pdFetch(
          `${base}/organizations/${org.id}/deals?status=open&sort=id+DESC&limit=1&${qs}`
        );
        const deal = dealsRes?.data?.[0];

        return json({
          org_id:     org.id,
          org_name:   org.name,
          deal_id:    deal?.id   || null,
          deal_title: deal?.title || null,
        });
      }

      // POST /so-number/increment — increment and save the order number counter (auth required)
      if (resource === 'so-number' && id === 'increment' && request.method === 'POST') {
        const raw  = await env.ORDER_COUNTER.get('so_number');
        const next = (raw !== null ? parseInt(raw, 10) : 0) + 1;
        await env.ORDER_COUNTER.put('so_number', String(next));
        return json({ order_number: next });
      }

      // PUT /so-number/set — set counter to specific value (auth required)
      if (resource === 'so-number' && id === 'set' && request.method === 'PUT') {
        const body  = await request.json().catch(() => ({}));
        const value = parseInt(body.value, 10);
        if (isNaN(value) || value < 1)
          return json({ error: 'value must be a positive integer' }, 400);
        await env.ORDER_COUNTER.put('so_number', String(value));
        return json({ success: true, order_number: value });
      }

      // GET /termination-text — fetch stored termination language
      if (resource === 'termination-text' && request.method === 'GET') {
        const raw = await env.ORDER_COUNTER.get('termination_text');
        return json({ text: raw || '' });
      }

      // PUT /termination-text — save termination language
      if (resource === 'termination-text' && request.method === 'PUT') {
        const body = await request.json().catch(() => ({}));
        await env.ORDER_COUNTER.put('termination_text', body.text || '');
        return json({ success: true });
      }

      // GET /discounts — fetch current discount config
      if (resource === 'discounts' && request.method === 'GET') {
        const raw = await env.ORDER_COUNTER.get('discounts');
        const defaults = { poc: 0, payg: 0, committed750: 5, committed: 10, prepaid: 20 };
        return json(raw ? JSON.parse(raw) : defaults);
      }

      // PUT /discounts — save discount config
      if (resource === 'discounts' && request.method === 'PUT') {
        const body = await request.json();
        for (const [k, v] of Object.entries(body)) {
          if (typeof v !== 'number' || v < 0 || v > 50)
            return json({ error: `Invalid discount for ${k}: must be 0–50` }, 400);
        }
        await env.ORDER_COUNTER.put('discounts', JSON.stringify(body));
        return json({ success: true, discounts: body });
      }

      // GET /mmf-discounts
      if (resource === 'mmf-discounts' && request.method === 'GET') {
        const raw      = await env.ORDER_COUNTER.get('mmf_discounts');
        const defaults = { poc: 0, payg: 0, committed750: 0, committed: 0, prepaid: 0 };
        return json(raw ? JSON.parse(raw) : defaults);
      }

      // PUT /mmf-discounts
      if (resource === 'mmf-discounts' && request.method === 'PUT') {
        const body = await request.json();
        await env.ORDER_COUNTER.put('mmf_discounts', JSON.stringify(body));
        return json({ success: true, discounts: body });
      }

      // GET /mla-url
      if (resource === 'mla-url' && request.method === 'GET') {
        const raw = await env.ORDER_COUNTER.get('mla_url');
        return json({ url: raw || 'https://hosted.ai/legal/Master_License_Agreement_v0.01.pdf' });
      }

      // PUT /mla-url
      if (resource === 'mla-url' && request.method === 'PUT') {
        const body = await request.json().catch(() => ({}));
        if (!body.url) return json({ error: 'url is required' }, 400);
        await env.ORDER_COUNTER.put('mla_url', body.url);
        return json({ success: true, url: body.url });
      }

      // GET /oneoff-items — fetch saved item name list
      if (resource === 'oneoff-items' && request.method === 'GET') {
        const raw = await env.ORDER_COUNTER.get('oneoff_item_names');
        return json({ items: raw ? JSON.parse(raw) : [] });
      }

      // POST /oneoff-items — save item name list
      if (resource === 'oneoff-items' && request.method === 'POST') {
        const body  = await request.json().catch(() => ({}));
        const items = [...new Set((body.items || []).filter(Boolean))].sort();
        await env.ORDER_COUNTER.put('oneoff_item_names', JSON.stringify(items));
        return json({ success: true, items });
      }

      // POST /reset — wipe all orders and/or reset counter
      // Body (all optional): { orders: true, counter: true, counter_seed: 327 }
      if (resource === 'reset' && request.method === 'POST') {
        const body         = await request.json().catch(() => ({}));
        const resetOrders  = body.orders  !== false;   // default true
        const resetCounter = body.counter !== false;   // default true
        const seed         = parseInt(body.counter_seed, 10) || KV_SEED;

        let deletedCount = 0;

        if (resetOrders) {
          // List and delete all order keys in batches
          let cursor;
          do {
            const list = await env.ORDERS.list({ prefix: 'order:', cursor });
            await Promise.all(list.keys.map(k => env.ORDERS.delete(k.name)));
            deletedCount += list.keys.length;
            cursor = list.list_complete ? undefined : list.cursor;
          } while (cursor);
        }

        if (resetCounter) {
          await env.ORDER_COUNTER.put(COUNTER_KEY, String(seed));
        }

        return json({
          success:         true,
          orders_deleted:  resetOrders  ? deletedCount : 'skipped',
          counter_reset:   resetCounter ? seed         : 'skipped',
          message:         'DB reset complete.',
        });
      }

      return json({ error: 'Not found' }, 404);

    } catch (err) {
      return json({ error: 'Internal error', detail: err.message, stack: err.stack?.split('\n')[1]?.trim() || '' }, 500);
    }
  },
};

// ── Pipedrive sync ────────────────────────────────────────────────────────────

async function syncToPipedrive(order, env) {
  if (!env.PIPEDRIVE_TOKEN || !env.PIPEDRIVE_DOMAIN) {
    return { skipped: true, reason: 'Pipedrive secrets not configured' };
  }

  const base = `https://${env.PIPEDRIVE_DOMAIN}.pipedrive.com/api/v1`;
  const qs   = `api_token=${env.PIPEDRIVE_TOKEN}`;
  const log  = [];

  try {
    // 1. Find or create Organization
    log.push(`Searching org: "${order.customer_name}"`);
    const orgResult = await findOrCreateOrg(base, qs, order);
    log.push(...(orgResult.log || []));
    const orgId = orgResult.orgId;
    if (!orgId) return { success: false, error: 'Could not find or create organization', log };

    // 2. Find or create Deal linked to org
    log.push(`Finding/creating deal for order #${order.order_number}`);
    const dealResult = await findOrCreateDeal(base, qs, order, orgId);
    log.push(...(dealResult.log || []));
    const dealId = dealResult.dealId;
    if (!dealId) return { success: false, error: 'Could not find or create deal', log };

    // 3. Generate PDF
    log.push(`Generating PDF...`);
    const mlaUrl         = (await env.ORDER_COUNTER.get('mla_url')) || 'https://hosted.ai/legal/Master_License_Agreement_v0.01.pdf';
    const terminationTxt = (await env.ORDER_COUNTER.get('termination_text')) || '';
    const pdfResult = await generatePdf({ ...order, mla_url: mlaUrl, termination_text: terminationTxt }, env);
    log.push(...(pdfResult.log || []));
    if (!pdfResult.pdfBytes) return { success: false, error: 'PDF generation failed', log };

    // 4. Attach PDF to Pipedrive deal Files tab
    log.push(`Attaching to Pipedrive deal #${dealId}...`);
    const fileResult = await attachToDeal(base, qs, order, dealId, pdfResult.pdfBytes);
    log.push(...(fileResult.log || []));

    return {
      success:           true,
      org_id:            orgId,
      deal_id:           dealId,
      pipedrive_file_id: fileResult.fileId,
      file_name:         `Sales_Order_${order.order_number}.pdf`,
      log,
    };
  } catch (e) {
    log.push(`Exception: ${e.message}`);
    return { success: false, error: e.message, log };
  }
}

// ── PDF generation ────────────────────────────────────────────────────────────

async function generatePdf(order, env) {
  const log = [];
  let pdfBytes;

  if (env.CF_ACCOUNT_ID && env.CF_API_TOKEN) {
    log.push(`Calling CF Browser Rendering...`);
    const pdfRes = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/browser-rendering/pdf`,
      {
        method:  'POST',
        headers: { 'Authorization': `Bearer ${env.CF_API_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          html: buildOrderHtml(order),
          addStyleTag: [{ content: '@page { margin: 20mm; } body { font-family: Arial, sans-serif; }' }],
        }),
      }
    );
    log.push(`CF status: ${pdfRes.status}`);
    if (pdfRes.ok) {
      pdfBytes = new Uint8Array(await pdfRes.arrayBuffer());
      log.push(`PDF: ${pdfBytes.length} bytes`);
    } else {
      const err = await pdfRes.text();
      log.push(`CF error: ${err}`);
    }
  } else {
    log.push('No CF credentials — HTML fallback');
    pdfBytes = new TextEncoder().encode(buildOrderHtml(order));
  }

  return { pdfBytes: pdfBytes || null, log };
}

// ── Attach PDF to Pipedrive deal Files tab ────────────────────────────────────

async function attachToDeal(base, qs, order, dealId, pdfBytes) {
  const log      = [];
  const fileName = `Sales_Order_${order.order_number}_${(order.customer_name || 'unknown').replace(/\s+/g, '_')}.pdf`;
  const boundary = '----PipedriveBoundary' + Math.random().toString(36).slice(2);

  const pre = new TextEncoder().encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/pdf\r\n\r\n`
  );
  const mid = new TextEncoder().encode(
    `\r\n--${boundary}\r\nContent-Disposition: form-data; name="deal_id"\r\n\r\n${dealId}\r\n--${boundary}--\r\n`
  );
  const body = new Uint8Array(pre.length + pdfBytes.length + mid.length);
  body.set(pre, 0);
  body.set(pdfBytes, pre.length);
  body.set(mid, pre.length + pdfBytes.length);

  const r    = await fetch(`${base}/files?${qs}`, {
    method:  'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Accept': 'application/json' },
    body,
  });
  const data = await r.json();
  log.push(`Pipedrive Files: status=${r.status}, success=${data?.success}, id=${data?.data?.id}, error=${data?.error || 'none'}`);
  return { fileId: data?.data?.id || null, log };
}

async function findOrCreateDeal(base, qs, order, orgId) {
  const log   = [];
  const title = `SO-${order.order_number} — ${order.customer_name || 'Unknown'}`;

  // Search for existing deal by order number in title
  const searchUrl = `${base}/deals/search?term=${encodeURIComponent(`SO-${order.order_number}`)}&exact_match=false&${qs}`;
  log.push(`Searching deal: "SO-${order.order_number}"`);
  const search   = await pdFetch(searchUrl);
  log.push(`Deal search: success=${search?.success}, items=${search?.data?.items?.length ?? 0}`);

  const existing = search?.data?.items?.[0]?.item;
  if (existing) {
    log.push(`Found deal: id=${existing.id} title="${existing.title}"`);
    // Update deal value if it changed
    const billStr = (order.estimated_monthly_bill || '').replace(/[^0-9.]/g, '');
    const value   = parseFloat(billStr) || 0;
    await pdPut(`${base}/deals/${existing.id}?${qs}`, { value, currency: order.currency || 'USD' });
    return { dealId: existing.id, log };
  }

  // Create new deal
  log.push(`Creating deal: "${title}"`);
  const billStr = (order.estimated_monthly_bill || '').replace(/[^0-9.]/g, '');
  const value   = parseFloat(billStr) || 0;
  const created = await pdPost(`${base}/deals?${qs}`, {
    title,
    value,
    currency: order.currency || 'USD',
    org_id:   orgId,
    status:   'open',
  });
  log.push(`Create deal: success=${created?.success}, id=${created?.data?.id}, error=${created?.error || 'none'}`);
  return { dealId: created?.data?.id || null, log };
}

async function findOrCreateOrg(base, qs, order) {
  const log  = [];
  const name = order.customer_name;
  if (!name) return { orgId: null, log: ['No customer_name provided'] };

  const searchUrl = `${base}/organizations/search?term=${encodeURIComponent(name)}&exact_match=true&${qs}`;
  log.push(`Searching: "${name}"`);
  const search = await pdFetch(searchUrl);
  log.push(`Search: success=${search?.success}, items=${search?.data?.items?.length ?? 0}, error=${search?.error || 'none'}`);

  const existing = search?.data?.items?.[0]?.item;
  const orgId    = existing
    ? existing.id
    : (await pdPost(`${base}/organizations?${qs}`, { name, address: order.customer_address || '' }))?.data?.id;

  if (!orgId) { log.push('Failed to find or create org'); return { orgId: null, log }; }
  log.push(`Org id=${orgId}`);

  // Resolve tech contact name → person ID
  const techPersonId    = await resolvePersonId(base, qs, order.tech_contact,  order.tech_email,   order.tech_phone,  orgId, log);
  // Resolve billing contact name → person ID
  const billingPersonId = await resolvePersonId(base, qs, order.billing_contact, order.billing_email, order.billing_phone, orgId, log);

  // Build update payload with all custom fields
  const payload = {
    address: order.customer_address || '',
    '317666d2e216abb25f07e94bde73f0aefe5039d8': order.tech_email      || '',
    'c928bc395d5bfb04addd3d3a8af45b670e75ceb4': order.tech_phone      || '',
    'e6ff39caec53c7f8168d8746086e30048b9f755a': order.billing_email   || '',
    'd3289881a78247f814a1233944f52cf1d68a1e4e': order.billing_phone   || '',
  };
  if (techPersonId)    payload['88cbe1f7ae31f61d5e4f24abce8ecaab9e741e80']  = techPersonId;
  if (billingPersonId) payload['877ec40425de5ce0bd5b18548d43f3f69c024d48'] = billingPersonId;

  const updated = await pdPut(`${base}/organizations/${orgId}?${qs}`, payload);
  log.push(`Org update: success=${updated?.success}, error=${updated?.error || 'none'}`);

  return { orgId, log };
}

// Find person by name in org, or create them
async function resolvePersonId(base, qs, personName, email, phone, orgId, log) {
  if (!personName) return null;

  // Search by name
  const search = await pdFetch(
    `${base}/persons/search?term=${encodeURIComponent(personName)}&fields=name&exact_match=true&org_id=${orgId}&${qs}`
  );
  const existing = search?.data?.items?.[0]?.item;
  if (existing) {
    log.push(`Found person "${personName}": id=${existing.id}`);
    // Update email/phone if provided
    const upd = {};
    if (email) upd.email = [{ value: email, primary: true }];
    if (phone) upd.phone = [{ value: phone, primary: true }];
    if (Object.keys(upd).length) await pdPut(`${base}/persons/${existing.id}?${qs}`, upd);
    return existing.id;
  }

  // Create new person linked to org
  const payload = { name: personName, org_id: orgId };
  if (email) payload.email = [{ value: email, primary: true }];
  if (phone) payload.phone = [{ value: phone, primary: true }];
  const created = await pdPost(`${base}/persons?${qs}`, payload);
  const newId   = created?.data?.id || null;
  log.push(`Created person "${personName}": id=${newId}, error=${created?.error || 'none'}`);
  return newId;
}

function buildOrderHtml(o) {
  const row = (label, value) => (value !== undefined && value !== null && value !== '' && value !== '0' && value !== 0)
    ? `<tr>
        <td style="padding:3px 16px 3px 0;font-weight:600;color:#374151;white-space:nowrap;vertical-align:top;width:200px;">${label}</td>
        <td style="padding:3px 0;color:#111827;">${value}</td>
       </tr>`
    : '';

  const section = (title) =>
    `<tr><td colspan="2" style="padding:20px 0 6px;"><div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:#6b7280;border-bottom:1px solid #e5e7eb;padding-bottom:6px;">${title}</div></td></tr>`;

const sigBox = (role, name, title, date, sigDataUrl) => `
    <div style="flex:1;min-width:220px;">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#6b7280;margin-bottom:10px;">${role}</div>
      <div style="border:1px solid #e5e7eb;border-radius:6px;background:#fafafa;height:70px;margin-bottom:14px;overflow:hidden;">
        ${sigDataUrl ? `<img src="${sigDataUrl}" style="width:100%;height:100%;object-fit:contain;">` : ''}
      </div>
      <div style="margin-bottom:10px;">
        <div style="display:flex;align-items:flex-end;gap:0;width:100%;">
          <span style="font-size:11px;font-weight:600;color:#374151;white-space:nowrap;padding-right:6px;padding-bottom:2px;">Name:</span>
          <div style="flex:1;border-bottom:1px solid #374151;font-size:12px;color:#111827;padding-bottom:2px;min-height:18px;">${name || ''}</div>
        </div>
      </div>
      <div style="margin-bottom:10px;">
        <div style="display:flex;align-items:flex-end;gap:0;width:100%;">
          <span style="font-size:11px;font-weight:600;color:#374151;white-space:nowrap;padding-right:6px;padding-bottom:2px;">Title:</span>
          <div style="flex:1;border-bottom:1px solid #374151;font-size:12px;color:#111827;padding-bottom:2px;min-height:18px;">${title || ''}</div>
        </div>
      </div>
      <div>
        <div style="display:flex;align-items:flex-end;gap:0;width:100%;">
          <span style="font-size:11px;font-weight:600;color:#374151;white-space:nowrap;padding-right:6px;padding-bottom:2px;">Date:</span>
          <div style="flex:1;border-bottom:1px solid #374151;font-size:12px;color:#111827;padding-bottom:2px;min-height:18px;">${date || ''}</div>
        </div>
      </div>
    </div>`;

  // Format discount display
  const discountDisplay = (o.discount_pct && o.discount_pct > 0) ? `${o.discount_pct}% off unit pricing` : 'None';
  const creditDisplay   = (o.monthly_credit && o.monthly_credit > 0) ? `$${Number(o.monthly_credit).toLocaleString('en-US', {minimumFractionDigits:2})} / month` : 'None';

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Sales Order #${o.order_number}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, Arial, sans-serif;
    font-size: 13px; color: #111827;
    max-width: 760px; margin: 0 auto; padding: 40px 32px;
    background: white;
  }
  /* Header */
  .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 32px; padding-bottom: 20px; border-bottom: 3px solid #1e3a5f; }
  .logo   { font-size: 22px; font-weight: 800; color: #1e3a5f; letter-spacing: -.5px; }
  .logo span { color: #3b82f6; }
  .order-meta { text-align: right; }
  .order-meta h1 { font-size: 18px; font-weight: 800; color: #1e3a5f; }
  .order-meta p  { font-size: 12px; color: #6b7280; margin-top: 3px; }
  /* Sections */
  table  { border-collapse: collapse; width: 100%; margin-bottom: 4px; }
  td     { vertical-align: top; }
  .section-title {
    font-size: 11px; font-weight: 700; text-transform: uppercase;
    letter-spacing: .6px; color: #6b7280;
    border-bottom: 1px solid #e5e7eb; padding-bottom: 6px;
    margin: 24px 0 10px;
  }
  /* Pricing table */
  .pricing-table { width: 100%; border-collapse: collapse; margin: 8px 0 16px; }
  .pricing-table th {
    background: #1e3a5f; color: white;
    padding: 8px 12px; font-size: 11px;
    text-transform: uppercase; letter-spacing: .4px;
    text-align: left; font-weight: 700;
  }
  .pricing-table td { padding: 8px 12px; border-bottom: 1px solid #f3f4f6; font-size: 12.5px; }
  .pricing-table tr:nth-child(even) td { background: #f9fafb; }
  .effective { font-weight: 700; color: ${(o.discount_pct > 0) ? '#059669' : '#1e3a5f'}; }
  /* Clause box */
  .clause {
    background: #f9fafb; border: 1px solid #e5e7eb; border-left: 3px solid #1e3a5f;
    border-radius: 4px; padding: 14px 16px; font-size: 12px;
    color: #374151; line-height: 1.7; margin: 8px 0 16px;
  }
  /* Sig section */
  .sig-grid { display: flex; gap: 40px; margin-top: 8px; flex-wrap: wrap; }
  /* Footer */
  .footer { margin-top: 40px; padding-top: 14px; border-top: 1px solid #e5e7eb; font-size: 10.5px; color: #9ca3af; display: flex; justify-content: space-between; }
  @media print { body { padding: 20px; } }
</style>
</head><body>

<!-- ── HEADER ── -->
<div class="header">
  <div>
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">
      <img src="https://hosted.ai/wp-content/uploads/2025/05/cropped-hostedai-site-icon-270x270.png"
           alt="hosted·ai" width="38" height="38"
           style="border-radius:6px;object-fit:contain;">
      <div class="logo">hosted<span>·</span>ai</div>
    </div>
    <div style="font-size:11px;color:#6b7280;margin-top:4px;">Hosted AI Inc. · 622 North 9th Street, San Jose, CA 95112</div>
  </div>
  <div class="order-meta">
    <h1>Sales Order #${o.order_number}</h1>
    <p>Contract Date: ${o.contract_date || '—'}</p>
    <p>Billing Start: ${o.billing_start || '—'}</p>
    ${o.po_number ? `<p>PO: ${o.po_number}</p>` : ''}
  </div>
</div>

<!-- ── CUSTOMER INFORMATION ── -->
<div class="section-title">Customer Information</div>
<table>
  ${row('Legal Name',         o.customer_name)}
  ${row('Registered Address', o.customer_address)}
  ${row('Tax ID / VAT',       o.tax_id)}
  ${row('PO Number',          o.po_number)}
</table>

${(o.primary_contact || o.primary_email || o.primary_phone) ? `
<div style="margin-top:12px;margin-bottom:4px;font-size:11px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:.4px;">Primary Contact</div>
<table>
  ${row('Name',  o.primary_contact)}
  ${row('Email', o.primary_email)}
  ${row('Phone', o.primary_phone)}
</table>` : ''}

${(o.tech_contact || o.tech_email || o.tech_phone) ? `
<div style="margin-top:12px;margin-bottom:4px;font-size:11px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:.4px;">Technical Contact</div>
<table>
  ${row('Name',  o.tech_contact)}
  ${row('Email', o.tech_email)}
  ${row('Phone', o.tech_phone)}
</table>` : ''}

${(o.billing_contact || o.billing_email || o.billing_address) ? `
<div style="margin-top:12px;margin-bottom:4px;font-size:11px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:.4px;">Billing (if different)</div>
<table>
  ${row('Contact Name',  o.billing_contact)}
  ${row('Contact Email', o.billing_email)}
  ${row('Contact Phone', o.billing_phone)}
  ${row('Address',       o.billing_address)}
</table>` : ''}

<!-- ── COMMERCIAL TERMS ── -->
<div class="section-title" style="margin-top:28px;">Commercial Terms</div>
<table>
  ${row('Service Model',      o.service_model)}
  ${row('Resource Discount',  discountDisplay)}
  ${row('Monthly Credit',     creditDisplay)}
  ${row('Billing Frequency',  o.billing_frequency === 'annual' ? 'Annual in advance' : o.billing_frequency === 'monthly' ? 'Monthly in advance' : o.billing_frequency)}
  ${row('Initial Term',       o.initial_term === 'mtm' ? 'Month-to-month' : o.initial_term === '12m' ? '12 months' : o.initial_term)}
  ${row('Renewal',            o.renewal === 'auto' ? 'Auto-renews (12-month periods)' : o.renewal === 'none' ? 'No auto-renewal' : o.renewal === 'na' ? 'N/A' : o.renewal)}
  ${row('Payment Terms',      o.payment_terms)}
  ${row('Currency',           o.currency)}
  ${row('Support Level',      o.support_level ? o.support_level.charAt(0).toUpperCase() + o.support_level.slice(1) : '')}
</table>

<!-- ── UNIT PRICING ── -->
<div style="page-break-before:always;margin-top:0;"></div>
<div style="height:24px;"></div>
<div class="section-title" style="margin-top:0;">Unit Pricing</div>
<table class="pricing-table">
  <thead>
    <tr>
      <th>Item</th>
      <th>Description</th>
      <th style="text-align:right;">Base Rate</th>
      <th style="text-align:right;">Effective Rate</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td><strong>GPU VRAM</strong><br><span style="font-size:11px;color:#6b7280;">Allocated</span></td>
      <td style="font-size:12px;color:#6b7280;">Per allocated GB of VRAM per hour</td>
      <td style="text-align:right;">$0.0005 / GB-h</td>
      <td style="text-align:right;" class="effective">$${(0.0005 * (1 - (o.discount_pct || 0) / 100)).toFixed(o.discount_pct > 0 ? 5 : 4)} / GB-h</td>
    </tr>
    <tr>
      <td><strong>GPU VRAM</strong><br><span style="font-size:11px;color:#6b7280;">Utilized</span></td>
      <td style="font-size:12px;color:#6b7280;">Per utilized GB of VRAM per hour</td>
      <td style="text-align:right;">$0.0030 / GB-h</td>
      <td style="text-align:right;" class="effective">$${(0.003 * (1 - (o.discount_pct || 0) / 100)).toFixed(o.discount_pct > 0 ? 5 : 4)} / GB-h</td>
    </tr>
  </tbody>
</table>
<div style="font-size:11.5px;color:#6b7280;margin-bottom:4px;">
  Monthly bill = MAX(0, Availability fee + Consumption fee − Monthly Credit). Overages billed in arrears.
</div>

${(o.oneoff_items && o.oneoff_items.length) ? `
<!-- ── ONE-OFF ITEMS ── -->
<div class="section-title" style="margin-top:28px;">One-off Items</div>
<table class="pricing-table">
  <thead><tr>
    <th>Description</th>
    <th style="text-align:center;">Qty</th>
    <th style="text-align:right;">Unit Cost</th>
    <th style="text-align:right;">Total</th>
  </tr></thead>
  <tbody>
    ${o.oneoff_items.map(i => {
      const qty   = Number(i.qty)  || 0;
      const cost  = Number(i.cost) || 0;
      const total = qty * cost;
      return `<tr>
        <td>${i.name || '—'}</td>
        <td style="text-align:center;">${qty}</td>
        <td style="text-align:right;">$${cost.toLocaleString('en-US',{minimumFractionDigits:2})}</td>
        <td style="text-align:right;font-weight:700;">$${total.toLocaleString('en-US',{minimumFractionDigits:2})}</td>
      </tr>`;
    }).join('')}
    <tr style="background:#f9fafb;font-weight:700;">
      <td colspan="3" style="text-align:right;padding-right:16px;">One-off Total</td>
      <td style="text-align:right;">$${o.oneoff_items.reduce((s,i)=>s+(Number(i.qty)||0)*(Number(i.cost)||0),0).toLocaleString('en-US',{minimumFractionDigits:2})}</td>
    </tr>
  </tbody>
</table>` : ''}

${o.custom_terms ? `
<!-- ── CUSTOM TERMS ── -->
<div class="section-title" style="margin-top:28px;">Additional Terms</div>
<div class="clause">${o.custom_terms.replace(/\n/g, '<br>')}</div>` : ''}

<!-- ── TERMINATION CLAUSE ── -->
<div class="section-title" style="margin-top:28px;">Termination</div>
<div class="clause">
  ${o.termination_text ? o.termination_text.replace(/\n/g, '<br>') : `
  <strong>Early Termination.</strong> Either party may terminate this Sales Order upon written notice if the other party materially breaches any provision and fails to cure such breach within thirty (30) days of receiving written notice thereof.
  ${o.initial_term === 'mtm'
    ? ' Customer may cancel month-to-month service with thirty (30) days\' prior written notice.'
    : ' This Sales Order has a minimum committed term of <strong>' + (o.initial_term === '12m' ? '12 months' : (o.initial_term || 'the agreed term')) + '</strong>. Early termination by Customer prior to the end of the committed term will result in a termination fee equal to the remaining monthly minimum commitment amounts for the unexpired term.'}
  ${o.renewal === 'auto'
    ? ' Unless either party provides written notice of non-renewal at least sixty (60) days prior to the end of the then-current term, this Sales Order will automatically renew for successive 12-month periods.'
    : o.renewal === 'none' ? ' This Sales Order will not automatically renew. Customer must execute a new Sales Order to continue service beyond the initial term.' : ''}
  All fees accrued prior to the effective date of termination remain due and payable. Sections relating to payment obligations, confidentiality, limitation of liability, and governing law survive termination.`}
</div>

<!-- ── SIGNATURES ── -->
<div class="section-title" style="margin-top:28px;">Signatures</div>
<p style="font-size:12px;color:#374151;margin-bottom:20px;">
  By signing below, each party agrees to be bound by the terms of this Sales Order and the
  <a href="${o.mla_url || 'https://hosted.ai/legal/Master_License_Agreement_v0.01.pdf'}" style="color:#3b82f6;">${o.mla_url || 'https://hosted.ai/legal/Master_License_Agreement_v0.01.pdf'}</a> governing the relationship between the parties.
</p>
<div class="sig-grid">
  ${sigBox('Hosted AI Inc. (Provider)', o.vendor_name  || 'Narendar Shankar', o.vendor_title  || 'CCO',  o.vendor_date, o.sig_vendor)}
  ${sigBox('Customer: ' + (o.customer_name || ''),       o.cust_sig_name,                    o.cust_sig_title, o.cust_date,   o.sig_customer)}
</div>

${o.estimator_in_print && o.estimated_monthly_bill ? `
<!-- ── BILLING ESTIMATE (new page) ── -->
<div style="page-break-before:always;margin-top:0;"></div>
<div style="height:24px;"></div>
<div class="section-title" style="margin-top:0;">Billing Estimate</div>
<p style="font-size:12px;color:#6b7280;margin-bottom:16px;font-style:italic;background:#f9fafb;border-left:3px solid #d1d5db;padding:10px 14px;border-radius:0 4px 4px 0;">
  <strong>Disclaimer:</strong> Price estimates below are for illustration purposes only. Actual charges will be based on metered GPU VRAM allocation and utilization as recorded by the hosted·ai platform. Estimates do not constitute a binding commitment or invoice.
</p>

<!-- GPU Cards selected -->
${(o.gpus && o.gpus.length) ? `
<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#6b7280;margin-bottom:6px;">GPU Configuration</div>
<table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:12px;">
  <thead>
    <tr style="background:#1e3a5f;">
      <th style="padding:7px 12px;text-align:left;color:white;font-size:11px;font-weight:700;letter-spacing:.4px;">GPU Model</th>
      <th style="padding:7px 12px;text-align:center;color:white;font-size:11px;font-weight:700;">Qty</th>
      <th style="padding:7px 12px;text-align:right;color:white;font-size:11px;font-weight:700;">VRAM / GPU</th>
      <th style="padding:7px 12px;text-align:right;color:white;font-size:11px;font-weight:700;">Total VRAM</th>
    </tr>
  </thead>
  <tbody>
    ${o.gpus.map((g, i) => `
    <tr style="background:${i%2===0?'#f9fafb':'white'};">
      <td style="padding:8px 12px;font-weight:600;">${g.gpu || '—'}</td>
      <td style="padding:8px 12px;text-align:center;">${g.qty}</td>
      <td style="padding:8px 12px;text-align:right;">${g.vram_gb} GB</td>
      <td style="padding:8px 12px;text-align:right;font-weight:700;">${(g.vram_gb * g.qty).toFixed(0)} GB</td>
    </tr>`).join('')}
    <tr style="border-top:2px solid #e5e7eb;background:#f0f4ff;">
      <td colspan="3" style="padding:8px 12px;font-weight:700;text-align:right;">Total Provisioned VRAM</td>
      <td style="padding:8px 12px;text-align:right;font-weight:800;color:#1e3a5f;">${o.est_total_vram || '—'}</td>
    </tr>
  </tbody>
</table>` : ''}

<!-- VRAM Utilization -->
<div style="display:flex;gap:16px;margin-bottom:16px;flex-wrap:wrap;">
  <div style="flex:1;background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:12px 16px;">
    <div style="font-size:11px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:.4px;margin-bottom:4px;">VRAM Utilization</div>
    <div style="font-size:20px;font-weight:800;color:#1e3a5f;">${o.vram_utilization_pct || o.vram_utilisation_pct || 0}%</div>
  </div>
  <div style="flex:1;background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:12px 16px;">
    <div style="font-size:11px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:.4px;margin-bottom:4px;">Resource Discount</div>
    <div style="font-size:20px;font-weight:800;color:#1e3a5f;">${o.discount_pct || 0}%</div>
  </div>
  <div style="flex:1;background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:12px 16px;">
    <div style="font-size:11px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:.4px;margin-bottom:4px;">Monthly Credit</div>
    <div style="font-size:20px;font-weight:800;color:#1e3a5f;">${o.est_monthly_credit || '—'}</div>
  </div>
</div>

<!-- Detailed Cost Breakdown -->
<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#6b7280;margin-bottom:6px;">Cost Breakdown</div>
<table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:4px;">
  <tr style="background:#f9fafb;border-bottom:1px solid #e5e7eb;">
    <td style="padding:9px 12px;color:#374151;">Availability Fee <span style="color:#9ca3af;font-size:11px;">(allocated VRAM × rate × 730 hrs/mo)</span></td>
    <td style="padding:9px 12px;text-align:right;font-weight:600;">${o.est_avail_fee || '—'}</td>
  </tr>
  <tr style="border-bottom:1px solid #e5e7eb;">
    <td style="padding:9px 12px;color:#374151;">Consumption Fee <span style="color:#9ca3af;font-size:11px;">(utilized VRAM × rate × 730 hrs/mo)</span></td>
    <td style="padding:9px 12px;text-align:right;font-weight:600;">${o.est_consumption_fee || '—'}</td>
  </tr>
  <tr style="background:#f9fafb;border-bottom:1px solid #e5e7eb;">
    <td style="padding:9px 12px;color:#374151;">Monthly Credit / Minimum Commitment</td>
    <td style="padding:9px 12px;text-align:right;font-weight:600;color:#059669;">${o.est_monthly_credit || '—'}</td>
  </tr>
  <tr style="border-top:2px solid #1e3a5f;background:#eff6ff;">
    <td style="padding:11px 12px;font-weight:800;font-size:14px;color:#1e3a5f;">
      Estimated Monthly Bill
      <div style="font-size:10.5px;font-weight:400;color:#6b7280;margin-top:2px;">MAX(0, Availability Fee + Consumption Fee − Monthly Credit)</div>
    </td>
    <td style="padding:11px 12px;text-align:right;font-weight:800;font-size:16px;color:#1e3a5f;">${o.estimated_monthly_bill}</td>
  </tr>
</table>
<div style="font-size:11px;color:#9ca3af;margin-top:6px;">
  Rates used: Availability $${(0.0005*(1-(o.discount_pct||0)/100)).toFixed(5)}/GB-h · Consumption $${(0.003*(1-(o.discount_pct||0)/100)).toFixed(5)}/GB-h · 730 hours/month assumed
</div>` : ''}

<!-- ── FOOTER ── -->
<div class="footer">
  <span>hosted·ai Sales Order #${o.order_number} · Confidential</span>
  <span>Generated ${new Date().toUTCString()}</span>
</div>

</body></html>`;
}

// ── Pipedrive HTTP helpers ────────────────────────────────────────────────────

async function pdFetch(url) {
  const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
  return r.json();
}

async function pdPost(url, body) {
  const r = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body:    JSON.stringify(body),
  });
  return r.json();
}

async function pdPut(url, body) {
  const r = await fetch(url, {
    method:  'PUT',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body:    JSON.stringify(body),
  });
  return r.json();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function now() { return new Date().toISOString(); }

function meta(r) {
  return {
    order_number: r.order_number,
    customer:     r.customer_name   || '',
    date:         r.contract_date   || '',
    model:        r.service_model   || '',
    saved_at:     r.saved_at        || '',
    updated_at:   r.updated_at      || '',
  };
}

// ── SalesOrderNumber custom field (b3cf4034d1e45135ee2384f0914c7a993a1b148b) ─
const SO_NUMBER_FIELD = 'b3cf4034d1e45135ee2384f0914c7a993a1b148b';

async function incrementSalesOrderNumber(base, qs, orgId) {
  try {
    const orgRes = await pdFetch(`${base}/organizations/${orgId}?${qs}`);
    const raw    = orgRes?.data?.[SO_NUMBER_FIELD];
    const current = parseInt(typeof raw === 'object' ? raw?.value ?? raw : raw, 10);
    const next   = (isNaN(current) ? 0 : current) + 1;

    // Save incremented value back to Pipedrive
    await pdPut(`${base}/organizations/${orgId}?${qs}`, {
      [SO_NUMBER_FIELD]: next,
    });

    return next;
  } catch (e) {
    return null;
  }
}



// Safely extract a string from a Pipedrive custom field —
// may come back as a plain string, a number, or an object like { value, label }
function pdField(val) {
  if (val === null || val === undefined) return '';
  if (typeof val === 'string')  return val;
  if (typeof val === 'number')  return String(val);
  if (typeof val === 'object')  return val.value ?? val.name ?? val.label ?? '';
  return String(val);
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

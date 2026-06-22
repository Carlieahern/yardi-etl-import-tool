// Vercel serverless proxy for the Monday.com GraphQL API.
// Keeps MONDAY_API_KEY server-side and avoids browser CORS.
//
// Actions (POST body { action, ... }):
//   "fetch"  { boardName }                  -> { boardId, mapping: [{ rpId, yardiId }], unmappedYardi: [rpId...] }
//   "update" { boardName, rpId, yardiId }   -> { ok, itemId, created }

const MONDAY_URL = "https://api.monday.com/v2";
const API_VERSION = "2024-01";

const BUDGETING_ID_TITLE = "Budgeting ID";
const PMS_TITLE = "PMS";

async function mondayQuery(query, variables) {
  const apiKey = process.env.MONDAY_API_KEY;
  if (!apiKey) {
    throw new Error(
      "MONDAY_API_KEY is not configured on the server. Add it in Vercel > Project Settings > Environment Variables."
    );
  }

  const res = await fetch(MONDAY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: apiKey,
      "API-Version": API_VERSION,
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await res.json();
  if (json.errors) {
    const msg = json.errors.map((e) => e.message).join("; ");
    throw new Error("Monday API error: " + msg);
  }
  if (!res.ok) {
    throw new Error("Monday API HTTP " + res.status);
  }
  return json.data;
}

// Find the board id whose name matches boardName (case-insensitive, trimmed).
async function findBoard(boardName) {
  const target = String(boardName).trim().toLowerCase();
  let page = 1;
  // Paginate boards in case the account has many.
  while (page <= 20) {
    const data = await mondayQuery(
      `query ($page: Int!) { boards (limit: 100, page: $page, state: active) { id name } }`,
      { page }
    );
    const boards = (data.boards || []).filter(Boolean);
    if (boards.length === 0) break;
    const match = boards.find((b) => b.name.trim().toLowerCase() === target);
    if (match) return match.id;
    page += 1;
  }
  throw new Error(`Board "${boardName}" was not found in this Monday account.`);
}

// Resolve the column ids for "Budgeting ID" and "PMS" by their titles.
async function getColumnIds(boardId) {
  const data = await mondayQuery(
    `query ($ids: [ID!]) { boards (ids: $ids) { columns { id title } } }`,
    { ids: [boardId] }
  );
  const cols = (data.boards?.[0]?.columns || []);
  const find = (title) =>
    cols.find((c) => c.title.trim().toLowerCase() === title.toLowerCase());
  const budgeting = find(BUDGETING_ID_TITLE);
  const pms = find(PMS_TITLE);
  if (!budgeting) {
    throw new Error(`Column "${BUDGETING_ID_TITLE}" not found on the board.`);
  }
  if (!pms) {
    throw new Error(`Column "${PMS_TITLE}" not found on the board.`);
  }
  return { budgetingColId: budgeting.id, pmsColId: pms.id };
}

// Fetch every item's Budgeting ID + PMS values, paginating via the cursor.
async function fetchAllItems(boardId, budgetingColId, pmsColId) {
  const items = [];

  const first = await mondayQuery(
    `query ($ids: [ID!], $colIds: [String!]) {
       boards (ids: $ids) {
         items_page (limit: 100) {
           cursor
           items { id name column_values (ids: $colIds) { id text } }
         }
       }
     }`,
    { ids: [boardId], colIds: [budgetingColId, pmsColId] }
  );

  let cursor = first.boards?.[0]?.items_page?.cursor || null;
  for (const it of first.boards?.[0]?.items_page?.items || []) items.push(it);

  while (cursor) {
    const next = await mondayQuery(
      `query ($cursor: String!, $colIds: [String!]) {
         next_items_page (limit: 100, cursor: $cursor) {
           cursor
           items { id name column_values (ids: $colIds) { id text } }
         }
       }`,
      { cursor, colIds: [budgetingColId, pmsColId] }
    );
    cursor = next.next_items_page?.cursor || null;
    for (const it of next.next_items_page?.items || []) items.push(it);
  }

  const textOf = (it, colId) => {
    const cv = it.column_values.find((c) => c.id === colId);
    return cv && cv.text != null ? String(cv.text).trim() : "";
  };

  return items.map((it) => ({
    itemId: it.id,
    rpId: textOf(it, budgetingColId),
    yardiId: textOf(it, pmsColId),
  }));
}

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { action = "fetch", boardName } = body || {};

  if (!boardName) {
    return Response.json({ error: "boardName is required." }, { status: 400 });
  }

  try {
    const boardId = await findBoard(boardName);
    const { budgetingColId, pmsColId } = await getColumnIds(boardId);

    if (action === "fetch") {
      const rows = await fetchAllItems(boardId, budgetingColId, pmsColId);
      const mapping = rows
        .filter((r) => r.rpId)
        .map((r) => ({ rpId: r.rpId, yardiId: r.yardiId }));
      const unmappedYardi = rows
        .filter((r) => r.rpId && !r.yardiId)
        .map((r) => r.rpId);
      return Response.json({ boardId, mapping, unmappedYardi });
    }

    if (action === "update") {
      const { rpId, yardiId } = body;
      if (!rpId || !yardiId) {
        return Response.json(
          { error: "rpId and yardiId are required for update." },
          { status: 400 }
        );
      }

      // Look for an existing item whose Budgeting ID matches rpId.
      const found = await mondayQuery(
        `query ($boardId: ID!, $colId: String!, $val: String!) {
           items_page_by_column_values (limit: 1, board_id: $boardId,
             columns: [{ column_id: $colId, column_values: [$val] }]) {
             items { id }
           }
         }`,
        { boardId, colId: budgetingColId, val: rpId }
      );

      const existingId = found.items_page_by_column_values?.items?.[0]?.id || null;

      if (existingId) {
        await mondayQuery(
          `mutation ($boardId: ID!, $itemId: ID!, $colId: String!, $val: String!) {
             change_simple_column_value (board_id: $boardId, item_id: $itemId,
               column_id: $colId, value: $val) { id }
           }`,
          { boardId, itemId: existingId, colId: pmsColId, val: yardiId }
        );
        return Response.json({ ok: true, itemId: existingId, created: false });
      }

      // No matching item: create one with both Budgeting ID and PMS set.
      const colValues = JSON.stringify({
        [budgetingColId]: rpId,
        [pmsColId]: yardiId,
      });
      const created = await mondayQuery(
        `mutation ($boardId: ID!, $name: String!, $vals: JSON!) {
           create_item (board_id: $boardId, item_name: $name, column_values: $vals) { id }
         }`,
        { boardId, name: rpId, vals: colValues }
      );
      const newId = created.create_item?.id || null;
      return Response.json({ ok: true, itemId: newId, created: true });
    }

    return Response.json({ error: "Unknown action." }, { status: 400 });
  } catch (err) {
    return Response.json(
      { error: err.message || "Unexpected server error." },
      { status: 500 }
    );
  }
}

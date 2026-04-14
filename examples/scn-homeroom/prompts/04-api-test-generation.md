# Prompt: API Test Generator Agent

## System Role

You are an API test engineer. You write tests that validate HTTP endpoints
directly, without browser involvement. Your tests verify contracts, auth,
error handling, and data integrity.

## Task

Generate API test files for each SCN endpoint group. Tests run via Vitest
with direct HTTP calls (no Playwright browser needed).

## Template Structure

```typescript
import { describe, it, expect, beforeAll } from 'vitest';
import { getAuthToken } from '../fixtures/auth-setup';

const API_BASE = 'https://slldt.lms360.vn/api/v3';

describe('API: /homeroom_notebooks [Endpoint Group]', () => {
  let gvcnToken: string;
  let adminToken: string;
  let notebookId: number;

  beforeAll(async () => {
    gvcnToken = await getAuthToken('gvcn');
    adminToken = await getAuthToken('admin');
  });

  // --- Schema Validation ---
  it('GET /homeroom_notebooks/class/:class_id returns correct schema', async () => {
    const res = await fetch(`${API_BASE}/homeroom_notebooks/class/${CLASS_ID}`, {
      headers: { Authorization: `Bearer ${gvcnToken}` },
    });

    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data).toHaveProperty('data');

    const notebook = data.data.homeroom_notebook || data.data;
    expect(notebook).toHaveProperty('id');
    expect(typeof notebook.id).toBe('number');
    expect(notebook).toHaveProperty('class_id');
    expect(notebook).toHaveProperty('academic_year_id');

    notebookId = notebook.id;
  });

  // --- Auth Tests ---
  it('returns 401 without token', async () => {
    const res = await fetch(`${API_BASE}/homeroom_notebooks/class/${CLASS_ID}`);
    expect(res.status).toBe(401);
  });

  // --- CRUD Tests ---
  it('PATCH updates notebook and GET reflects change', async () => {
    const updatePayload = { /* specific field */ };
    const patchRes = await fetch(`${API_BASE}/homeroom_notebooks/${notebookId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${gvcnToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(updatePayload),
    });
    expect(patchRes.status).toBeLessThan(400);

    // Verify with GET
    const getRes = await fetch(`${API_BASE}/homeroom_notebooks/class/${CLASS_ID}`, {
      headers: { Authorization: `Bearer ${gvcnToken}` },
    });
    const getData = await getRes.json();
    // Assert updated field matches
  });

  // --- Pagination ---
  it('paginated endpoint respects page_id and per_page', async () => {
    const res = await fetch(
      `${API_BASE}/homeroom_notebooks/${notebookId}/thong_tin_hs?page_id=1&per_page=5`,
      { headers: { Authorization: `Bearer ${gvcnToken}` } }
    );
    const data = await res.json();
    expect(Array.isArray(data.data?.students || data.data)).toBe(true);
  });
});
```

## Endpoint Groups to Cover

1. **Core notebook**: GET/PATCH/DELETE /homeroom_notebooks
2. **Parents**: GET /parents
3. **Parent committee**: CRUD /ban_dai_dien_cmhs
4. **Student info**: GET/PATCH /thong_tin_hs
5. **Teachers**: GET /gvbm
6. **Class officers**: CRUD /can_bo_lop, /can_bo_doan_doi
7. **Student groups**: CRUD /to_hs
8. **Seating**: CRUD /so_do_lop
9. **Timetable**: CRUD /scn_timetable
10. **Class situation**: GET/PATCH /thong_ke_tinh_hinh, /chat_luong_chung
11. **Plans**: CRUD /ke_hoach_chu_nhiem, /ke_hoach_thang, /ke_hoach_tuan
12. **Student tracking**: GET /theo_doi_tung_hs, /kqrl_thang
13. **Parent meetings**: CRUD /buoi_hop_ph
14. **BGH review**: GET/PATCH /bgh_nhan_xet

## Auth Matrix Template

For each endpoint group:
```typescript
const AUTH_MATRIX = [
  { role: 'gvcn', token: () => gvcnToken, expectedStatus: 200 },
  { role: 'admin', token: () => adminToken, expectedStatus: 200 },
  { role: 'none', token: () => '', expectedStatus: 401 },
];

AUTH_MATRIX.forEach(({ role, token, expectedStatus }) => {
  it(`returns ${expectedStatus} for role=${role}`, async () => {
    const res = await fetch(url, {
      headers: token() ? { Authorization: `Bearer ${token()}` } : {},
    });
    expect(res.status).toBe(expectedStatus);
  });
});
```

## Rules

1. NEVER check only status code — always validate response body schema
2. ALWAYS test auth with multiple roles
3. ALWAYS capture response time and log if > threshold
4. NEVER hardcode IDs — obtain from setup/previous responses
5. For write operations: verify with subsequent GET
6. For delete operations: verify 404 on subsequent GET
7. Test error responses have consistent { errors: [...] } shape

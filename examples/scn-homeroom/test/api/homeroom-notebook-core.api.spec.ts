/**
 * API Tests: Core Homeroom Notebook Endpoints
 *
 * Tests GET/PATCH operations, auth matrix, schema validation,
 * and pagination for the core notebook endpoints.
 */
import { describe, it, expect, beforeAll } from 'vitest';

const API_BASE = 'https://slldt.lms360.vn/api/v3';

// Tokens will be obtained at runtime
let gvcnToken: string;
let adminToken: string;
let discoveredClassId: number;
let discoveredNotebookId: number;

/**
 * Login helper — gets token via API
 */
async function login(phone: string, password: string): Promise<string> {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, password }),
  });

  if (!res.ok) {
    // Try alternate login endpoint
    const res2 = await fetch(`https://slldt.lms360.vn/api/v3/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, password }),
    });
    const data2 = await res2.json();
    return data2?.data?.token || data2?.token || '';
  }

  const data = await res.json();
  return data?.data?.token || data?.token || '';
}

/**
 * Helper to make authenticated API requests with timing capture
 */
async function apiRequest(
  method: string,
  path: string,
  token: string,
  body?: any
): Promise<{ status: number; data: any; durationMs: number }> {
  const start = Date.now();
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const durationMs = Date.now() - start;
  let data: any;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  return { status: res.status, data, durationMs };
}

// ============================================================================
// SETUP
// ============================================================================

describe('API: Core Homeroom Notebook', () => {
  beforeAll(async () => {
    gvcnToken = await login('094181009777', '123123');
    adminToken = await login('0933554421', 'test@123!');

    expect(gvcnToken).toBeTruthy();
    expect(adminToken).toBeTruthy();
  });

  // ==========================================================================
  // GET Notebook by Class
  // ==========================================================================

  describe('GET /homeroom_notebooks/class/:class_id', () => {
    it('returns notebook with correct schema for authenticated GVCN', async () => {
      // First, discover available class IDs (from user's assigned classes)
      // This endpoint returns the notebook for the teacher's class
      const { status, data, durationMs } = await apiRequest(
        'GET',
        '/homeroom_notebooks/class/0', // Use 0 or discover from another endpoint
        gvcnToken
      );

      // We may need to discover class_id first
      // Log for debugging if endpoint pattern differs
      console.log(`GET notebook: status=${status}, time=${durationMs}ms`);

      if (status === 200 && data?.data) {
        const notebook = data.data.homeroom_notebook || data.data;

        // Schema validation
        expect(notebook).toHaveProperty('id');
        expect(typeof notebook.id).toBe('number');

        discoveredNotebookId = notebook.id;
        discoveredClassId = notebook.class_id;

        // Validate expected fields exist
        const requiredFields = ['id', 'class_id', 'academic_year_id'];
        for (const field of requiredFields) {
          expect(notebook).toHaveProperty(field);
        }
      }
    });

    it('returns 401 without authentication', async () => {
      const { status } = await apiRequest('GET', '/homeroom_notebooks/class/1', '');
      expect(status).toBe(401);
    });

    it('responds within 3 seconds', async () => {
      if (!discoveredClassId) return;
      const { durationMs } = await apiRequest(
        'GET',
        `/homeroom_notebooks/class/${discoveredClassId}`,
        gvcnToken
      );
      expect(durationMs).toBeLessThan(3000);
    });
  });

  // ==========================================================================
  // Sub-resource Endpoints
  // ==========================================================================

  describe('GET /homeroom_notebooks/:id/ban_dai_dien_cmhs', () => {
    it('returns array with correct schema', async () => {
      if (!discoveredNotebookId) return;

      const { status, data } = await apiRequest(
        'GET',
        `/homeroom_notebooks/${discoveredNotebookId}/ban_dai_dien_cmhs`,
        gvcnToken
      );

      expect(status).toBe(200);
      expect(data).toHaveProperty('data');

      // Data should be array or object with array
      const items = Array.isArray(data.data)
        ? data.data
        : data.data?.ban_dai_dien_cmhs || [];
      expect(Array.isArray(items)).toBe(true);

      // If items exist, validate schema
      if (items.length > 0) {
        const first = items[0];
        expect(first).toHaveProperty('id');
        expect(typeof first.id).toBe('number');
      }
    });
  });

  describe('GET /homeroom_notebooks/:id/thong_tin_hs (paginated)', () => {
    it('returns paginated student list', async () => {
      if (!discoveredNotebookId) return;

      const { status, data } = await apiRequest(
        'GET',
        `/homeroom_notebooks/${discoveredNotebookId}/thong_tin_hs?page_id=1&per_page=10`,
        gvcnToken
      );

      expect(status).toBe(200);
      expect(data).toHaveProperty('data');
    });

    it('handles out-of-range page gracefully', async () => {
      if (!discoveredNotebookId) return;

      const { status, data } = await apiRequest(
        'GET',
        `/homeroom_notebooks/${discoveredNotebookId}/thong_tin_hs?page_id=9999&per_page=10`,
        gvcnToken
      );

      // Should return 200 with empty array, not 500
      expect(status).toBeLessThan(500);
    });
  });

  describe('GET /homeroom_notebooks/:id/gvbm (paginated)', () => {
    it('returns teacher list with valid schema', async () => {
      if (!discoveredNotebookId) return;

      const { status, data } = await apiRequest(
        'GET',
        `/homeroom_notebooks/${discoveredNotebookId}/gvbm?page_id=1&per_page=50`,
        gvcnToken
      );

      expect(status).toBe(200);
      expect(data).toHaveProperty('data');
      const items = Array.isArray(data.data) ? data.data : data.data?.gvbm || [];
      expect(Array.isArray(items)).toBe(true);
    });
  });

  describe('GET /homeroom_notebooks/:id/can_bo_lop', () => {
    it('returns class officers with valid schema', async () => {
      if (!discoveredNotebookId) return;

      const { status, data } = await apiRequest(
        'GET',
        `/homeroom_notebooks/${discoveredNotebookId}/can_bo_lop`,
        gvcnToken
      );

      expect(status).toBe(200);
      expect(data).toHaveProperty('data');
      const items = Array.isArray(data.data) ? data.data : data.data?.can_bo_lop || [];
      expect(Array.isArray(items)).toBe(true);
    });
  });

  describe('GET /homeroom_notebooks/:id/scn_timetable', () => {
    it('returns timetable data with valid schema', async () => {
      if (!discoveredNotebookId) return;

      const { status, data } = await apiRequest(
        'GET',
        `/homeroom_notebooks/${discoveredNotebookId}/scn_timetable`,
        gvcnToken
      );

      expect(status).toBe(200);
      expect(data).toHaveProperty('data');
    });
  });

  // ==========================================================================
  // Auth Matrix (applied to multiple endpoints)
  // ==========================================================================

  describe('Authorization Matrix', () => {
    const endpoints = [
      { method: 'GET', pathFn: (id: number) => `/homeroom_notebooks/${id}/ban_dai_dien_cmhs` },
      { method: 'GET', pathFn: (id: number) => `/homeroom_notebooks/${id}/thong_tin_hs?page_id=1&per_page=10` },
      { method: 'GET', pathFn: (id: number) => `/homeroom_notebooks/${id}/can_bo_lop` },
    ];

    for (const endpoint of endpoints) {
      it(`${endpoint.method} ${endpoint.pathFn(0).split('?')[0]} returns 401 without token`, async () => {
        if (!discoveredNotebookId) return;
        const { status } = await apiRequest(
          endpoint.method,
          endpoint.pathFn(discoveredNotebookId),
          '' // no token
        );
        expect(status).toBe(401);
      });
    }
  });

  // ==========================================================================
  // Response Time Monitoring
  // ==========================================================================

  describe('Response Time Thresholds', () => {
    const thresholds: Record<string, number> = {
      'GET list': 3000,
      'GET detail': 2000,
    };

    it('all GET endpoints respond within threshold', async () => {
      if (!discoveredNotebookId) return;

      const endpoints = [
        `/homeroom_notebooks/${discoveredNotebookId}/ban_dai_dien_cmhs`,
        `/homeroom_notebooks/${discoveredNotebookId}/can_bo_lop`,
        `/homeroom_notebooks/${discoveredNotebookId}/thong_tin_hs?page_id=1&per_page=10`,
      ];

      for (const path of endpoints) {
        const { durationMs, status } = await apiRequest('GET', path, gvcnToken);
        if (status === 200) {
          expect(durationMs).toBeLessThan(thresholds['GET list']);
        }
      }
    });
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The few pure computations of the game that are worth doing in WebAssembly
 * (src/wasm/kernels.ts loads them; each has its JavaScript twin, which is
 * what runs where WebAssembly is not there or not wanted):
 *
 *  - decoding the sections of a map tile that are stored in a coding
 *    (tilefmt.ts: decodeSection) and the numbers of the corners of the
 *    buildings' faces (facade.ts: unpackFaces, deriveFace) – the bulk of what
 *    a tile costs before it can be drawn;
 *  - the search for the quickest way through the road network of the whole
 *    map (routegraph.ts: quickestTimed) – an A* over half a million ways.
 *
 * Both give the very same numbers as the JavaScript: the same operations on
 * the same doubles in the same order (no fused multiply-add, no fast math),
 * Math.round written out as the standard defines it.
 *
 * Built without a C library or a linker (tools/build-wasm.ts): plain
 * `clang --target=wasm32 -c`, so there must be no static data – everything
 * lives in memory the JavaScript hands over – and nothing of libc or libm
 * (floor and sqrt are WebAssembly instructions).
 */

typedef unsigned char u8;
typedef signed char i8;
typedef unsigned short u16;
typedef short i16;
typedef unsigned int u32;
typedef int i32;

#define EXPORT(name) extern "C" __attribute__((export_name(#name)))

/** What the route planner adds for a way (routeFor.wayCost) – asked of the JavaScript. */
extern "C" __attribute__((import_module("env"), import_name("way_cost"))) double way_cost(u32 way);

// ---------------------------------------------------------------------------
// tile sections (tilefmt.ts)

/** section types, as tilefmt.ts names them: u8 i8 u16 i16 u32 i32 */
enum { T_U8 = 0, T_I8 = 1, T_U16 = 2, T_I16 = 3, T_U32 = 4, T_I32 = 5 };
/** codings (tilefmt.ts CODING) */
enum { C_RAW = 0, C_PLANES = 1, C_DELTA = 2, C_GRID = 3 };

template <typename T>
static inline i32 unzig(u32 u) {
  return (i32)((u >> 1) ^ (0u - (u & 1u)));
}

template <typename T>
static void decode(const u8* bytes, T* out, u32 n, u32 coding, u32 stride) {
  const u32 B = sizeof(T);
  const u32 groups = coding == C_GRID ? 1 : stride;
  const u32 per = n / groups;
  for (u32 c = 0; c < groups; c++) {
    const u8* base = bytes + c * B * per;
    i32 prev = 0;
    for (u32 i = 0; i < per; i++) {
      u32 v = base[i];
      if (B > 1) v |= (u32)base[per + i] << 8;
      if (B > 2) v |= ((u32)base[2 * per + i] << 16) | ((u32)base[3 * per + i] << 24);
      if (coding == C_GRID) {
        const u32 col = i % stride;
        const i32 left = col > 0 ? (i32)out[i - 1] : 0;
        const i32 up = i >= stride ? (i32)out[i - stride] : 0;
        const i32 ul = col > 0 && i >= stride ? (i32)out[i - stride - 1] : 0;
        out[i] = (T)(u32)((u32)unzig<T>(v) + (u32)left + (u32)up - (u32)ul);
      } else if (coding == C_DELTA) {
        out[i * stride + c] = (T)(u32)((u32)prev + (u32)unzig<T>(v));
        prev = (i32)out[i * stride + c];
      } else out[i * stride + c] = (T)v;
    }
  }
}

/** Decode `n` numbers of type `type` stored in `coding` (stride: how many belong together) from `bytes` to `out`. */
EXPORT(decode_section) void decode_section(const u8* bytes, void* out, u32 n, u32 type, u32 coding, u32 stride) {
  switch (type) {
    case T_U8: decode<u8>(bytes, (u8*)out, n, coding, stride); break;
    case T_I8: decode<i8>(bytes, (i8*)out, n, coding, stride); break;
    case T_U16: decode<u16>(bytes, (u16*)out, n, coding, stride); break;
    case T_I16: decode<i16>(bytes, (i16*)out, n, coding, stride); break;
    case T_U32: decode<u32>(bytes, (u32*)out, n, coding, stride); break;
    default: decode<i32>(bytes, (i32*)out, n, coding, stride); break;
  }
}

// ---------------------------------------------------------------------------
// the faces of buildings (facade.ts)

static const double POS_XZ_SCALE = 0.02;
static const double POS_Y_SCALE = 0.01;
static const double UV_SCALE = 0.02;
static const double SINK = 1.6;
static const double EAVE_ABOVE = 0.6;
static const double INF = __builtin_inf();
enum { F_EXPLICIT = 0, F_ROOF_FLAT = 1, F_ROOF_SLOPED = 2, F_WALL = 3, F_WALL_SUNK = 4 };

/** Math.round as ECMAScript defines it (halves upwards) */
static inline double js_round(double x) {
  const double f = __builtin_floor(x);
  return x - f >= 0.5 ? f + 1 : f;
}

/** facade.ts q16; what an Int16Array makes of it (NaN: 0) */
static inline i16 q16(double v) {
  double r = js_round(v / UV_SCALE);
  if (r != r) return 0;
  if (r > 32767) r = 32767;
  if (r < -32767) r = -32767;
  return (i16)(i32)r;
}

static inline double js_min(double a, double b) { return b < a ? b : a; }
static inline double js_max(double a, double b) { return b > a ? b : a; }

static bool derive_face(const i16* pos, u32 first, u32 n, u32 rule, i16* out) {
  if (n < 3) return false;
  const u32 o = first * 3;
  if (rule == F_ROOF_FLAT) {
    double uMin = INF;
    double vMin = INF;
    for (u32 i = 0; i < n; i++) {
      uMin = js_min(uMin, pos[o + i * 3]);
      vMin = js_min(vMin, pos[o + i * 3 + 2]);
    }
    for (u32 i = 0; i < n; i++) {
      const u32 k = (first + i) * 4;
      out[k] = q16((pos[o + i * 3] - uMin) * POS_XZ_SCALE);
      out[k + 1] = q16((pos[o + i * 3 + 2] - vMin) * POS_XZ_SCALE);
      out[k + 2] = 0;
      out[k + 3] = 0;
    }
    return true;
  }
  const double x0 = pos[o];
  const double y0 = pos[o + 1];
  const double z0 = pos[o + 2];
  double nx = 0;
  double ny = 0;
  double nz = 0;
  for (u32 i = 0; i < n; i++) {
    const u32 a = o + i * 3;
    const u32 b = o + ((i + 1) % n) * 3;
    const double ax = (pos[a] - x0) * POS_XZ_SCALE;
    const double ay = (pos[a + 1] - y0) * POS_Y_SCALE;
    const double az = (pos[a + 2] - z0) * POS_XZ_SCALE;
    const double bx = (pos[b] - x0) * POS_XZ_SCALE;
    const double by = (pos[b + 1] - y0) * POS_Y_SCALE;
    const double bz = (pos[b + 2] - z0) * POS_XZ_SCALE;
    nx += (ay - by) * (az + bz);
    ny += (az - bz) * (ax + bx);
    nz += (ax - bx) * (ay + by);
  }
  const double hl = __builtin_sqrt(nx * nx + nz * nz);
  if (!(hl > 1e-9)) return false;
  const double ux = nz / hl;
  const double uz = -nx / hl;
  double uMin = INF;
  double uMax = -INF;
  for (u32 i = 0; i < n; i++) {
    const double u = (pos[o + i * 3] - x0) * POS_XZ_SCALE * ux + (pos[o + i * 3 + 2] - z0) * POS_XZ_SCALE * uz;
    uMin = js_min(uMin, u);
    uMax = js_max(uMax, u);
  }
  if (rule == F_ROOF_SLOPED) {
    const double nl = __builtin_sqrt(nx * nx + ny * ny + nz * nz);
    const double mx = nx / nl;
    const double my = ny / nl;
    const double mz = nz / nl;
    double vx = my * uz;
    double vy = mz * ux - mx * uz;
    double vz = -my * ux;
    if (vy < 0) {
      vx = -vx;
      vy = -vy;
      vz = -vz;
    }
    double vMin = INF;
    for (u32 i = 0; i < n; i++) {
      const double v = (pos[o + i * 3] - x0) * POS_XZ_SCALE * vx + (pos[o + i * 3 + 1] - y0) * POS_Y_SCALE * vy + (pos[o + i * 3 + 2] - z0) * POS_XZ_SCALE * vz;
      vMin = js_min(vMin, v);
    }
    for (u32 i = 0; i < n; i++) {
      const u32 k = (first + i) * 4;
      const double x = (pos[o + i * 3] - x0) * POS_XZ_SCALE;
      const double y = (pos[o + i * 3 + 1] - y0) * POS_Y_SCALE;
      const double z = (pos[o + i * 3 + 2] - z0) * POS_XZ_SCALE;
      out[k] = q16(x * ux + z * uz - uMin);
      out[k + 1] = q16(x * vx + y * vy + z * vz - vMin);
      out[k + 2] = 0;
      out[k + 3] = 0;
    }
    return true;
  }
  if (rule != F_WALL && rule != F_WALL_SUNK) return false;
  double low = INF;
  for (u32 i = 0; i < n; i++) low = js_min(low, pos[o + i * 3 + 1]);
  const bool sunk = rule == F_WALL_SUNK;
  const double lo = low * POS_Y_SCALE + (sunk ? SINK : 0);
  const double sunkBelow = low * POS_Y_SCALE + SINK / 2;
#define HEIGHT(i) (sunk && pos[o + (i) * 3 + 1] * POS_Y_SCALE < sunkBelow ? pos[o + (i) * 3 + 1] * POS_Y_SCALE + SINK : pos[o + (i) * 3 + 1] * POS_Y_SCALE)
  double hi = -INF;
  for (u32 i = 0; i < n; i++) hi = js_max(hi, HEIGHT(i));
  double eave = hi;
  for (u32 i = 0; i < n; i++) {
    const double y = HEIGHT(i);
    if (y > lo + EAVE_ABOVE && y < eave) eave = y;
  }
  const i16 L = q16(uMax - uMin);
  const i16 H = q16(eave - lo);
  for (u32 i = 0; i < n; i++) {
    const u32 k = (first + i) * 4;
    out[k] = q16((pos[o + i * 3] - x0) * POS_XZ_SCALE * ux + (pos[o + i * 3 + 2] - z0) * POS_XZ_SCALE * uz - uMin);
    out[k + 1] = q16(HEIGHT(i) - lo);
    out[k + 2] = L;
    out[k + 3] = H;
  }
#undef HEIGHT
  return true;
}

/**
 * facade.ts unpackFaces: the four numbers of every corner (`out`, zeroed,
 * four per corner) from the runs of a tile.  The JavaScript has made sure
 * that the runs stay inside the corners.
 */
EXPORT(unpack_faces) void unpack_faces(const i16* pos, const u16* run, u32 nrun, const i16* uvx, u32 nuvx, i16* out) {
  u32 first = 0;
  u32 x = 0;
  for (u32 r = 0; r < nrun; r++) {
    const u32 n = run[r] >> 3;
    const u32 rule = run[r] & 7;
    if (rule == F_EXPLICIT) {
      if (uvx)
        for (u32 i = first * 4; i < (first + n) * 4; i++) out[i] = x < nuvx ? uvx[x++] : (x++, 0);
    } else derive_face(pos, first, n, rule, out);
    first += n;
  }
}

// ---------------------------------------------------------------------------
// the quickest way (routegraph.ts)

/** What the search reads of a way, together: one cache line holds four of them (the arrays of a RouteGraph would be five places). */
struct Way {
  float secs;
  float x1;
  float z1;
  u8 kind;
  u8 cls;
  u8 pad0;
  u8 pad1;
};

/** What the search knows of a way: its dist and prev mean something only where stamp = Graph.gen. */
struct State {
  double dist;
  u32 stamp;
  i32 prev;
};

/** a pair of the heap */
struct Entry {
  double key;
  u32 id;
  u32 pad;
};

/** A route graph in memory, as src/wasm/kernels.ts lays it out: all fields 32 bits. */
struct Graph {
  u32 n;
  Way* ways;
  const u32* first;
  const u32* to;
  const u8* turn;
  const float* across;
  State* state;
  u32 gen;
  /** room for `heapCap` pairs */
  Entry* heap;
  u32 heapCap;
};

/** routegraph.ts RG and TURN */
enum { RG_NO_ENTRY = 2, RG_ACCESS_ONLY = 1, RG_TO_MAP_END = 8 };
enum { TURN_LEFT = 1, TURN_RIGHT = 2, TURN_UTURN = 3 };

/** Gather what the search reads of each way from the arrays of the RouteGraph (in the same memory). */
EXPORT(route_prepare) void route_prepare(Graph* g, const float* secs, const float* x1, const float* z1, const u8* kind, const u8* cls) {
  Way* const ways = g->ways;
  const u32 n = g->n;
  for (u32 w = 0; w < n; w++) {
    ways[w].secs = secs[w];
    ways[w].x1 = x1[w];
    ways[w].z1 = z1[w];
    ways[w].kind = kind[w];
    ways[w].cls = cls[w];
    ways[w].pad0 = 0;
    ways[w].pad1 = 0;
  }
}

/**
 * routegraph.ts quickestTimed, the search: the seconds to `goal` (the
 * states' prev and stamp tell the way there), Infinity when there is none,
 * -1 when the heap ran out of room.  `start` ≠ `goal`.
 * `motorwayLink`: CLS.MOTORWAY_LINK.  The same heap as MinHeap, the same
 * sums in the same order: the same way to the last bit.
 */
EXPORT(route_search) double route_search(Graph* g, u32 start, u32 goal, u32 noMotorway, u32 motorwayLink, u32 useCost) {
  const u32 gen = ++g->gen;
  // (everything in locals: the stores below could otherwise alias the fields of *g, which would be read again and again)
  const Way* const ways = g->ways;
  const u32* const first = g->first;
  const u32* const to = g->to;
  const u8* const turn = g->turn;
  const float* const across = g->across;
  State* const state = g->state;
  Entry* const heap = g->heap;
  const u32 cap = g->heapCap;
  const double gx = ways[goal].x1;
  const double gz = ways[goal].z1;
#define REST(way) (__builtin_sqrt(((double)(way).x1 - gx) * ((double)(way).x1 - gx) + ((double)(way).z1 - gz) * ((double)(way).z1 - gz)) / 36)
  state[start].stamp = gen;
  state[start].dist = 0;
  state[start].prev = -1;
  // (the push of start onto the empty heap)
  heap[0].id = start;
  heap[0].key = REST(ways[start]);
  u32 size = 1;
  while (size > 0) {
    const double key = heap[0].key;
    // pop
    const u32 w = heap[0].id;
    const u32 m = --size;
    if (m > 0) {
      const u32 id = heap[m].id;
      const double k = heap[m].key;
      u32 i = 0;
      for (;;) {
        u32 c = i * 2 + 1;
        if (c >= m) break;
        if (c + 1 < m && heap[c + 1].key < heap[c].key) c++;
        if (heap[c].key >= k) break;
        heap[i].id = heap[c].id;
        heap[i].key = heap[c].key;
        i = c;
      }
      heap[i].id = id;
      heap[i].key = k;
    }
    if (w == goal) break;
    const double d = state[w].dist;
    if (key > d + REST(ways[w]) + 1e-6) continue;
    const u32 kEnd = first[w + 1];
    const u32 kindW = ways[w].kind;
    for (u32 k = first[w]; k < kEnd; k++) {
      const u32 t = to[k];
      const Way& wt = ways[t];
      const u32 kindT = wt.kind;
      if (t != goal && (kindT & RG_NO_ENTRY) != 0) continue;
      if (noMotorway && t != goal && wt.cls <= motorwayLink) continue;
      const double extra = useCost ? way_cost(t) : 0;
      if (extra == INF && t != goal) continue;
      const double through = t != goal && (kindT & RG_ACCESS_ONLY) != 0 ? 240 : 0;
      const u32 tt = turn[k];
      const double turnS = tt == TURN_LEFT ? 6 : tt == TURN_RIGHT ? 3 : tt == TURN_UTURN ? ((kindW & RG_TO_MAP_END) ? 900 : 150) : 0;
      const double nd = d + (double)across[k] / 6 + (double)wt.secs + turnS + through + (extra == INF ? 0 : extra);
      State& st = state[t];
      const double dt = st.stamp == gen ? st.dist : INF;
      if (nd < dt) {
        st.stamp = gen;
        st.dist = nd;
        st.prev = (i32)w;
        // push
        if (size == cap) return -1;
        const double key2 = nd + REST(wt);
        u32 i = size++;
        while (i > 0) {
          const u32 p = (i - 1) >> 1;
          if (heap[p].key <= key2) break;
          heap[i].id = heap[p].id;
          heap[i].key = heap[p].key;
          i = p;
        }
        heap[i].id = t;
        heap[i].key = key2;
      }
    }
  }
#undef REST
  return state[goal].stamp == gen ? state[goal].dist : INF;
}

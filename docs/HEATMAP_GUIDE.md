# 🧬 Từ File h5ad đến Heatmap: Hướng dẫn toàn diện

> Tài liệu này giải thích **toàn bộ quy trình** — từ một file dữ liệu sinh học thô (`.h5ad`) cho đến một heatmap tương tác hiển thị trên trình duyệt — theo cách **ai cũng hiểu được**, kể cả người chưa biết lập trình.
>
> **Phiên bản 0.2** — Hỗ trợ 20 triệu tế bào (out-of-core). Xem [`plans/20M_CELLS_FEASIBLE_PLAN.md`](../plans/20M_CELLS_FEASIBLE_PLAN.md) cho chi tiết kỹ thuật.

---

## 📋 Mục lục

1. [Bối cảnh: Heatmap là gì và tại sao cần nó?](#1-bối-cảnh-heatmap-là-gì-và-tại-sao-cần-nó)
2. [Tổng quan quy trình (Big Picture)](#2-tổng-quan-quy-trình-big-picture)
3. [Bước 1: Đọc file h5ad — Out-of-core streaming](#bước-1-đọc-file-h5ad--out-of-core-streaming)
4. [Bước 2: Sắp xếp lại theo cụm (Cluster Sorting)](#bước-2-sắp-xếp-lại-theo-cụm-cluster-sorting)
5. [Bước 3: Xây dựng kim tự tháp đa độ phân giải (Zarr Pyramid)](#bước-3-xây-dựng-kim-tự-tháp-đa-độ-phân-giải-zarr-pyramid)
6. [Bước 4: Tạo ảnh PNG động + disk cache (Dynamic Tile Generation)](#bước-4-tạo-ảnh-png-động--disk-cache-dynamic-tile-generation)
7. [Bước 5: Máy chủ phục vụ ảnh (FastAPI Server)](#bước-5-máy-chủ-phục-vụ-ảnh-fastapi-server)
8. [Bước 6: Trình duyệt tải và hiển thị (Frontend)](#bước-6-trình-duyệt-tải-và-hiển-thị-frontend)
9. [Bước 7: Tô màu trên GPU (Shader)](#bước-7-tô-màu-trên-gpu-shader)
10. [Bước 8: Tương tác người dùng (Zoom, Pan, Hover)](#bước-8-tương-tác-người-dùng-zoom-pan-hover)
11. [Cách tính toán và hiển thị ô (Tile Computation & Display)](#cách-tính-toán-và-hiển-thị-ô-tile-computation--display)
12. [Sơ đồ tổng thể kiến trúc](#sơ-đồ-tổng-thể-kiến-trúc)
13. [Câu hỏi thường gặp (Q&A)](#-câu-hỏi-thường-gặp-qa)
    - [Q1: Ô 256×256 nghĩa là gì? Vì sao chọn 256?](#q1-ô-256x256-nghĩa-là-256-gen--256-tế-bào-vì-sao-chọn-256)
    - [Q2: Ở mọi level, ô PNG đều là 256×256?](#q2-ở-mọi-level-ô-png-đều-là-256x256-phải-không)
    - [Q3: Tại sao shape ở level sau = 1/2 level trước?](#q3-tại-sao-kích-thước-ma-trận-shape-ở-level-sau--12-level-trước)
    - [Q4: Tại sao không gộp build + generate?](#q4-tại-sao-không-gộp-build_pyramid--generate_pyramid-làm-1)
    - [Q5: Hỗ trợ 20 triệu tế bào như thế nào?](#q5-hỗ-trợ-20-triệu-tế-bào-như-thế-nào)

---

## 1. Bối cảnh: Heatmap là gì và tại sao cần nó?

### Vấn đề

Trong sinh học tế bào đơn (single-cell RNA-seq), nhà nghiên cứu đo lường **mức độ biểu hiện gen** của hàng nghìn đến hàng triệu tế bào. Kết quả là một **bảng số khổng lồ**:

- **Mỗi hàng** = một gen (ví dụ: 20.000 gen)
- **Mỗi cột** = một tế bào (ví dụ: 2.638 tế bào trong dữ liệu thử nghiệm, mục tiêu **20 triệu tế bào**)
- **Mỗi ô** = một con số: gen này biểu hiện bao nhiêu trong tế bào đó

```
              Tế bào 1   Tế bào 2   Tế bào 3   ...  Tế bào 2638
Gen A           0.00       2.34       0.00    ...     1.87
Gen B           3.12       0.00       1.45    ...     0.00
Gen C           0.00       0.00       0.00    ...     2.91
  ⋮              ⋮          ⋮          ⋮               ⋮
Gen 50402       1.55       0.78       2.10    ...     0.00
```

Bảng này có **50.402 × 2.638 = hơn 133 triệu ô**. Bạn không thể nhìn bảng số này mà hiểu được gì.

### Giải pháp: Heatmap

**Heatmap** (bản đồ nhiệt) là cách trực quan hóa bảng số: mỗi ô được tô một màu, từ tối (giá trị thấp) đến sáng (giá trị cao). Nhìn heatmap, bạn ngay lập tức thấy:

- **Khối màu** = nhóm tế bào có biểu hiện gen giống nhau (cụm/cluster)
- **Dải ngang** = một gen biểu hiện cao/thấp ở một nhóm tế bào cụ thể
- **Mẫu tổng thể** = cấu trúc sinh học ẩn trong dữ liệu

```
    ┌──────────────────────────────────────────┐
    │ ░░░░▓▓▓▓████▓▓▓▓░░░░ │ ▓▓▓▓██████▓▓░░░░ │   ← Gen A
    │ ▓▓▓▓██████████▓▓▓▓ │ ░░░░░░░░▓▓▓▓░░░░ │   ← Gen B
    │ ░░░░░░░░▓▓▓▓░░░░░░ │ ▓▓▓▓██████▓▓▓▓▓▓ │   ← Gen C
    │  ← Cụm 1 →  khe  ← Cụm 2 →  khe →     │
    └──────────────────────────────────────────┘
     X = tế bào (cột)    Y = gen (hàng)
     ░ = thấp  ▓ = trung  █ = cao
```

### Thách thức kỹ thuật

Hiển thị 133 triệu ô (mục tiêu: **400 tỷ ô** cho 20M tế bào × 20K gen) trên trình duyệt với **60 khung hình/giây** là bài toán cực khó:

| Thách thức | Giải pháp trong dự án này |
|---|---|
| Dữ liệu quá lớn cho RAM (1,6 TB dense) | **Out-of-core streaming** — đọc từng chunk 50K tế bào, không load toàn bộ |
| Không thể tải tất cả cùng lúc | **Kim tự tháp đa độ phân giải** — tải đúng mức chi tiết cho mức zoom hiện tại |
| Tô màu tốn CPU | **GPU shader** tô màu tức thì |
| Chuyển bảng màu chậm | **Bảng tra cứu (LUT)** trên GPU — đổi màu trong 0ms |
| Vẽ lại khi zoom | **Index-based culling** — chỉ tính ô trong khung nhìn (không quét 6,2M ô) |
| Float32 jitter ở 20M tế bào | **RTC (Relative-To-Center)** — tọa độ tương đối, luôn < 16,7M |
| Browser OOM với 20M cell_ids | **Lazy metadata fetch** — chỉ tải cell names cho vùng đang xem |
| Tạo PNG tĩnh = 6,2M file (inode chết) | **Dynamic tile + disk LRU cache** — render on-the-fly, cache trên SSD |

---

## 2. Tổng quan quy trình (Big Picture)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    PIPELINE TỔNG QUAN (v0.2 — 20M cells)                │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  [File .h5ad]          [build_pyramid.py]                                │
│  Dữ liệu thô     →     Out-of-core streaming:                           │
│  (sinh học)            1. Streaming transpose (chunk 50K cells)        │
│  (sparse, ~250 GB)    2. Cluster reorder (zarr fancy indexing)          │
│                       3. Dask pyramid coarsening (18 levels)            │
│                       4. Streaming percentile (random sample)          │
│                              ↓                                          │
│                     data/heatmap.zarr/                                   │
│                     (ma trận đa tầng, nén zstd, ~150-250 GB)            │
│                              ↓                                          │
│                    [server.py] FastAPI (async)                          │
│                    ┌─ POST /api/tile → render on-the-fly                │
│                    │  + disk LRU cache (20 GB, 24h TTL)                │
│                    ├─ POST /api/obs/range → lazy metadata (chỉ vùng xem) │
│                    ├─ POST /api/custom → out-of-core gene subset        │
│                    └─ GET /tiles/... → static (legacy, small datasets)   │
│                              ↓  HTTP                                    │
│                    [Trình duyệt] Deck.gl                                 │
│                    ┌─ Index-based culling (binary search)              │
│                    ├─ RTC coordinate (Float32 precision)               │
│                    ├─ Lazy obs fetch (chỉ <5K cells visible)           │
│                    └─ GPU shader tô màu                                 │
│                              ↓                                          │
│                    🔥 HEATMAP HIỂN THỊ (20M cells, 60 FPS)              │
└─────────────────────────────────────────────────────────────────────────┘
```

Dưới đây là từng bước chi tiết.

---

## Bước 1: Đọc file h5ad — Out-of-core streaming

### Ý tưởng

File `.h5ad` là định dạng chuẩn trong sinh học (HDF5 + AnnData). Nó chứa:

```
┌─────────────── Cấu trúc file .h5ad ───────────────┐
│                                                    │
│  X          → Bảng số chính (tế bào × gen)         │
│  layers     → Các phiên bản đã xử lý (log_normalize)│
│  obs        → Thông tin từng tế bào (cluster, UMAP)│
│  var        → Thông tin từng gen (tên gen)          │
│  obsm       → Ma trận phụ (tọa độ UMAP 2D)          │
│                                                    │
└────────────────────────────────────────────────────┘
```

### Vì sao cần bước này?

Trước khi làm gì, ta phải **đọc dữ liệu vào bộ nhớ** và **chọn phiên bản nào** để hiển thị. File h5ad có thể chứa nhiều "lớp" (layers) — ví dụ `X` (thô) và `log_normalize` (đã chuẩn hóa). Ta chọn lớp đã chuẩn hóa vì nó trực quan hơn.

### Chi tiết kỹ thuật — Hai đường ống (dual path)

Dự án có **hai đường ống** tùy kích thước dữ liệu:

#### Đường ống nhỏ (< 2M tế bào) — In-memory (nhanh)

```python
# backend/build_pyramid.py — _build_small()
adata = read_h5ad(h5ad_path)          # Đọc toàn bộ file vào RAM
mat = adata.layers["log_normalize"]  # Chọn lớp đã chuẩn hóa
mat = mat.toarray()                   # Chuyển sparse → dense
mat = mat.T                           # Xoay: (tế bào, gen) → (gen, tế bào)
```

OK cho dữ liệu nhỏ: 50402 × 2638 × 4 byte ≈ 500 MB.

#### Đường ống lớn (≥ 2M tế bào) — Out-of-core streaming

Với 20M tế bào × 20K gen × float32 = **1,6 TB** — không thể load vào RAM. Thay vào đó, đọc từng chunk:

```python
# backend/build_pyramid.py — _streaming_transpose()
adata = read_h5ad(h5ad_path, backed='r')   # Lazy, KHÔNG load X
for c0 in range(0, n_cells, 50_000):         # Chunk 50K tế bào
    sparse_block = mat_source[c0:c1, :]      # (50K, 20K) sparse — 4 GB dense
    dense_block = sparse_block.toarray()
    transposed = dense_block.T                # (20K, 50K) gene-major
    arr[:, c0:c1] = transposed                # Ghi vào zarr trung gian
```

Peak RAM ≈ 8 GB (1 dense chunk + transpose). Vừa 16 GB RAM.

**Quan trọng — Ma trận bị xoay (transpose):**
```
  Ban đầu (trong h5ad):          Sau khi xoay:
  (tế bào, gen)                  (gen, tế bào)
  20M hàng × 20K cột            20K hàng × 20M cột
  Hàng = tế bào                  Hàng = gen (trục Y)
  Cột = gen                      Cột = tế bào (trục X)
```

Lý do xoay: trong heatmap, **gen là hàng (Y)** và **tế bào là cột (X)**. Việc xoay ngay từ đầu giúp mọi bước sau nhất quán.

### Ưu điểm
- **Nhỏ**: đọc một lần, giữ trong RAM — nhanh
- **Lớn**: streaming chunk — RAM luôn < 8 GB bất kể kích thước dữ liệu
- Chọn đúng lớp dữ liệu (đã chuẩn hóa) cho hiển thị

### Nhược điểm
- **Nhỏ**: toàn bộ ma trận phải vừa trong RAM
- **Lớn**: chậm hơn (I/O-bound), cần zarr trung gian (~150-250 GB đĩa)
- Sparse → dense tốn bộ nhớ (nhưng chỉ 1 chunk tại lúc)

---

## Bước 2: Sắp xếp lại theo cụm (Cluster Sorting)

### Ý tưởng

Nếu ta hiển thị tế bào theo thứ tự ngẫu nhiên, heatmap sẽ là một mảng màu lộn xộn — không thấy được cấu trúc. Thay vào đó, ta **nhóm các tế bào cùng cụm lại gần nhau** và **sắp xếp các cụm theo kích thước giảm dần** (cụm lớn nhất trước).

```
TRƯỚC sắp xếp (ngẫu nhiên):     SAU sắp xếp (theo cụm):

  Tế bào: 3 1 4 2 5 6 8 7        Tế bào: 1 3 5 2 4 8 6 7
  Cụm:    B A B A B A B A        Cụm:    A A A B B B A A
                                         ←Cụm A→ ←B→ ←A→
  (lộn xộn, không thấy gì)        (thấy rõ 2 khối: A rồi B)
```

### Vì sao cần bước này?

Sắp xếp theo cụm biến heatmap từ "nhiễu trắng" thành "bức tranh có ý nghĩa" — các khối màu xuất hiện, mỗi khối là một nhóm tế bào có hành vi gen giống nhau. Đây là bước **quan trọng nhất** để heatmap có giá trị trực quan.

### Chi tiết kỹ thuật

```python
# backend/build_pyramid.py — hàm _cluster_order()
labels = obs["louvain"]                    # Nhãn cụm của từng tế bào
unique, inverse, counts = np.unique(...)  # Đếm tế bào mỗi cụm
cluster_rank = np.argsort(-counts)         # Xếp giảm dần theo kích thước
# Sắp xếp ổn định: tế bào cùng cụm ở cạnh nhau, thứ tự trong cụm giữ nguyên
order = np.argsort(rank_per_cell, kind="stable")
```

**Với dữ liệu nhỏ (< 2M):** áp dụng trực tiếp `mat = mat[:, order]` (in-memory).

**Với dữ liệu lớn (≥ 2M):** reorder out-of-core — gather từng tile 256×256 từ zarr trung gian theo thứ tự đã reorder:

```python
# backend/build_pyramid.py — _reorder_cells()
for gt in range(n_gene_tiles):           # ~79 gene-tiles
    for ct in range(n_cell_tiles):       # ~78K cell-tiles
        reordered_indices = order[c_start:c_end]  # 256 cell indices
        # Zarr orthogonal fancy indexing — chỉ load 1 tile 256×256
        block = src.oindex[g0:g1, reordered_indices]
        dst[g0:g1, c_start:c_end] = block
```

RAM tối thiểu (256 KB/tile + 80 MB permutation). Không load toàn bộ ma trận.

Kết quả với dữ liệu thử nghiệm: **8 cụm**, cụm lớn nhất (CD4 T cells, 1144 tế bào) trước, cụm nhỏ nhất sau.

```
┌─────────────────────────────────────────────────────────────┐
│  Sắp xếp theo cụm (giảm dần theo kích thước):                │
│                                                             │
│  ← CD4 T (1144) →← Monocytes (480) →← B (342) →← ... →     │
│                                                             │
│  ┌──────────────┐┌──────────┐┌────────┐┌───┐┌───┐         │
│  │   Cụm 1      ││  Cụm 2   ││ Cụm 3  ││...││...│         │
│  │  (lớn nhất)  ││          ││        ││   ││   │         │
│  └──────────────┘└──────────┘└────────┘└───┘└───┘         │
│  ↑ Khe (gap) giữa các cụm được thêm ở bước hiển thị        │
└─────────────────────────────────────────────────────────────┘
```

### Ưu điểm
- Heatmap ngay lập tức cho thấy cấu trúc cụm
- Cụm lớn nhất ở bên trái — dễ tập trung vào nhóm chính trước

### Nhược điểm
- Thứ tự trong cụm giữ nguyên (không tối ưu thêm) — có thể có nhiễu nhỏ bên trong cụm
- Phụ thuộc vào cột cụm có sẵn trong dữ liệu (louvain) — nếu không có, sắp xếp theo thứ tự gốc

---

## Bước 3: Xây dựng kim tự tháp đa độ phân giải (Zarr Pyramid)

### Ý tưởng

Khi bạn xem Google Maps, khi zoom ra bạn thấy cả thế giới (ít chi tiết), khi zoom vào bạn thấy đường phố (nhiều chi tiết). Tương tự, ta xây **nhiều phiên bản** của heatmap ở các độ phân giải khác nhau:

```
Cấp 0 (đầy đủ):  50402 × 2638  ← Mỗi ô = 1 tế bào × 1 gen (chi tiết nhất)
Cấp 1:           25201 × 1319  ← Gộp 2×2 ô thành 1 (bớt chi tiết)
Cấp 2:           12600 × 659   ← Lại gộp 2×2
   ⋮                ⋮
Cấp 8:           196 × 10      ← Rất thô (toàn bộ heatmap vừa 1 ô)
```

### Vì sao cần bước này?

- **Khi zoom ra** (xem toàn bộ): tải cấp 8 (10×196 ô) — siêu nhanh
- **Khi zoom vào** (xem chi tiết): tải cấp 0 — đầy đủ chi tiết
- **Không bao giờ** phải tải toàn bộ 133 triệu ô cùng lúc

### Chi tiết kỹ thuật — Gộp 2×2 (mean pooling) — Out-of-core với Dask

Mỗi cấp gộp 2×2 ô của cấp trước bằng **giá trị trung bình**:

```
Cấp 0 (4 ô):              Cấp 1 (1 ô):
┌─────┬─────┐            ┌──────────┐
│ 2.0 │ 4.0 │            │ (2+4+6+8)│
├─────┼─────┤   ──→      │    /4   │
│ 6.0 │ 8.0 │            │  = 5.0  │
└─────┴─────┘            └──────────┘
```

**Điểm mới (v0.2):** Gộp được thực hiện **out-of-core** bằng Dask — không bao giờ giữ toàn bộ ma trận trong RAM. Dask đọc `level_0` từ Zarr một cách lười (`da.from_zarr`), gộp 2×2, ghi `level_1` lại Zarr, rồi đọc `level_1` lười để gộp `level_2`, v.v. Mỗi bước chỉ giữ một cấp trong RAM tại một thời điểm:

```python
# backend/build_pyramid.py — _build_pyramid_levels()
arr0 = root["level_0"]                    # Zarr array (trên đĩa)
current = da.from_zarr(arr0)               # Dask lazy — KHÔNG load vào RAM
for level in range(1, n_levels):
    coarse = _coarsen_mean(current, 2)     # 2×2 mean pooling (lazy)
    coarse = coarse.rechunk(chunks)       # Giữ chunk 256×256
    z = root.zeros(f"level_{level}", ...)  # Tạo Zarr array mới
    coarse.to_zarr(z.store, ...)           # Ghi từng chunk ra đĩa
    current = da.from_zarr(z)              # Đọc lại lười cho cấp tiếp theo
```

```python
# backend/build_pyramid.py — hàm _coarsen_mean()
def _coarsen_mean(arr, factor=2):
    return da.coarsen(np.nanmean, arr, {0: factor, 1: factor})
```

**Lưu ý quan trọng:** Chỉ gộp theo cả 2 chiều (gen và tế bào). Mỗi cấp giảm đi một nửa cả chiều ngang lẫn dọc. Dask tự động chia công việc theo chunk, nên với 20M tế bào × 20K gen (level 0 = 400 tỷ giá trị), RAM vẫn chỉ cần ~2 GB cho một chunk 256×256 tại một thời điểm.

### Lưu trữ Zarr

Zarr là định dạng lưu ma trận **chia thành khối (chunks)** trên đĩa — mỗi khối 256×256, nén riêng (zstd level 3):

```
data/heatmap.zarr/
├── meta.json          ← Siêu dữ liệu (kích thước, số cấp, khoảng giá trị, cụm)
├── level_0/           ← Cấp 0 (50402×2638, chia thành 197×11 khối)
│   ├── 0.0.0          ← Khối hàng 0, cột 0 (nén zstd)
│   ├── 0.0.1          ← Khối hàng 0, cột 1
│   └── ...
├── level_1/           ← Cấp 1 (25201×1319)
├── level_2/           ← Cấp 2 (12600×659)
├── ... cho đến level_8
├── cell_order/        ← Mảng int32: thứ tự sắp xếp lại tế bào (NEW v0.2)
├── cell_ids/          ← Tên tế bào (sau khi reorder)
├── louvain/           ← Nhãn cụm (sau khi reorder)
└── umap/              ← Tọa độ UMAP (sau khi reorder)
```

> **Thay đổi v0.2:** `cell_order` (mảng hoán vị tế bào) được lưu là **mảng Zarr** (int32, nén), KHÔNG còn trong `meta.json`. Với 20M tế bào, lưu JSON sẽ tốn ~160 MB text; Zarr nén chỉ ~80 MB và có thể đọc từng phần.

```
┌─────────── Cấu trúc kim tự tháp Zarr ───────────┐
│                                                  │
│   Cấp 8:  ████          (196×10 — toàn bộ)       │
│   Cấp 7:  ██████        (393×20)                  │
│   Cấp 6:  ████████      (787×41)                  │
│   Cấp 5:  ████████████  (1575×82)                 │
│    ⋮         ⋮                                    │
│   Cấp 0:  ████████████████████████  (50402×2638)  │
│           ← Đáy = chi tiết nhất →                │
│           ← Đỉnh = thô nhất →                    │
└──────────────────────────────────────────────────┘
```

### Streaming percentile — Tính vmin/vmax không cần load toàn bộ

Với 20M tế bào × 20K gen = 400 tỷ giá trị, không thể tính percentile chính xác trên toàn bộ dữ liệu (cần ~1,6 TB RAM). Thay vào đó, ta **lấy mẫu ngẫu nhiên**:

```python
# backend/build_pyramid.py — _streaming_percentile()
# Lấy mẫu 10M giá trị từ các tile ngẫu nhiên của level_0
n_sample_tiles = sample_size // (tile_size * tile_size)  # ~152 tile
rng = np.random.default_rng(42)
g_chunks = rng.integers(0, n_gene_chunks, size=n_sample_tiles)
c_chunks = rng.integers(0, n_cell_chunks, size=n_sample_tiles)

samples = []
for g, c in zip(g_chunks, c_chunks):
    block = arr[g*256:(g+1)*256, c*256:(c+1)*256]  # Đọc 1 tile
    vals = block[np.isfinite(block) & (block > 0)]  # Chỉ giá trị > 0
    samples.append(vals.ravel())

vmin = np.percentile(np.concatenate(samples), 1)   # p1
vmax = np.percentile(np.concatenate(samples), 99)   # p99
```

**Độ chính xác:** Lấy 10M giá trị từ 400 tỷ → sai số percentile < 0,1% (theo luật số lớn). Đủ chính xác cho tô màu heatmap. Nếu dataset nhỏ (< 2M tế bào), fallback quét toàn bộ.

### meta.json — "bản đồ" của kim tự tháp

```json
{
  "n_cells": 2638,
  "n_genes": 50402,
  "n_levels": 9,
  "levels": [[50402, 2638], [25201, 1319], ...],
  "vmin": 0.9648,    // Giá trị thấp nhất (p1, cho tô màu)
  "vmax": 4.7932,    // Giá trị cao nhất (p99)
  "groups": [        // Thông tin cụm cho hiển thị khe
    {"id": "CD4 T cells", "size": 1144},
    {"id": "CD14+ Monocytes", "size": 480},
    ...
  ]
}
```

> **Lưu ý:** `cell_order` (mảng hoán vị) KHÔNG còn ở đây — nó được lưu riêng trong Zarr (`cell_order/`) để tránh meta.json phình to với 20M tế bào.

### Ưu điểm
- Trình duyệt chỉ tải cấp phù hợp với mức zoom → cực nhanh
- Zarr chia khối → đọc từng phần mà không cần tải toàn bộ
- Lưu trên đĩa, dùng lại được nhiều lần
- **Out-of-core**: Dask + Zarr giữ RAM < 8 GB dù dữ liệu 400 tỷ giá trị

### Nhược điểm
- Tốn dung lượng đĩa (tất cả các cấp ≈ 1.5× dữ liệu gốc)
- Gộp trung bình làm mất chi tiết ở cấp thấp — nhưng đó là mục đích
- Xây kim tự tháp tốn thời gian (vài phút cho 2.6K tế bào, vài giờ cho 20M)
- Percentile lấy mẫu (xấp xỉ, không chính xác tuyệt đối) — nhưng sai số < 0,1%

---

## Bước 4: Tạo ảnh PNG động + disk cache (Dynamic Tile Generation)

### Ý tưởng

Zarr lưu **số** (float). Trình duyệt cần **ảnh** (PNG). Thay vì tạo trước **tất cả** ảnh PNG tĩnh (v0.1), ta **render từng ô theo yêu cầu** khi trình duyệt hỏi, rồi **cache kết quả trên đĩa SSD** (LRU, 20 GB, TTL 24h).

```
Trình duyệt hỏi:  POST /api/tile  body: {"level":2,"row":0,"col":2}
                         ↓
Máy chủ:          1. Kiểm tra disk cache → có? → trả ngay
                  2. Không? → đọc ô từ Zarr → render PNG → lưu cache → trả
                         ↓
                 Trả về PNG 256×256 (grayscale)
```

> **Thay đổi v0.2:** Trước đây `generate_pyramid.py` tạo trước tất cả PNG tĩnh (`data/tiles/default/`). Với 20M tế bào, cần **6,2 triệu file PNG** → inode table nổ, build mất nhiều giờ. Dynamic tile + disk cache giải quyết: chỉ render ô nào được xem, cache trên SSD, tự động eviction LRU.

```
Cấp 2 (12600 × 659):    Render theo yêu cầu (không tạo trước):
┌───────────────────────────┐    POST /api/tile (body: level,row,col)
│                           │         ↓
│     Ma trận 12600×659      │  ──→  Zarr[r0:r1, c0:c1] → PNG → cache
│                           │         ↓
└───────────────────────────┘    data/.tile_cache/ (LRU 20 GB)
```

### Vì sao cần bước này?

- **Dynamic tile** = không tạo trước hàng triệu file → tiết kiệm inode + build time
- **Disk LRU cache** = ô đã render được phục vụ nhanh như file tĩnh (đọc SSD)
- **Tự động eviction** = cache cũ tự xóa (TTL 24h), dung lượng giới hạn 20 GB
- **Tách biệt** "chuẩn bị dữ liệu" (Zarr) và "tạo ảnh" (render on-the-fly)

### Chi tiết kỹ thuật — Disk LRU cache

```python
# backend/tile_cache.py — TileCache (dùng diskcache library)
class TileCache:
    def __init__(self, path, max_size=20*10**9, ttl=86400):
        self.cache = diskcache.Cache(str(path), size_limit=max_size)
        self.ttl = ttl

    def get_or_render(self, key, render_fn):
        """Trả PNG từ cache; nếu chưa có, render_fn() rồi lưu."""
        cached = self.cache.get(key, expiration=self.ttl)
        if cached is not None:
            return cached
        png = render_fn()          # Đọc Zarr → render PNG
        self.cache.set(key, png, expire=self.ttl)
        return png
```

```python
# backend/server.py — _serve_tile_sync()
def _serve_tile_sync(level, row, col):
    key = f"t/{level}/{row}/{col}"
    vmin = float(_store.meta["vmin"])
    vmax = float(_store.meta["vmax"])
    def render():
        block = _store.tile(level, row, col)    # Đọc 1 ô từ Zarr
        return render_tile_png(block, vmin, vmax) # Mã hóa grayscale
    return tile_cache.get_or_render(key, render)  # Cache hoặc render
```

> **Async:** Endpoint `get_tile()` dùng `asyncio.to_thread(_serve_tile_sync, ...)` để render CPU-bound chạy trong thread riêng, không chặn event loop. Nhiều ô được render song song.

### Chi tiết kỹ thuật — Mã hóa grayscale (không đổi)

Mỗi pixel trong PNG là **1 byte (0–255)**, không phải màu RGB:

```
Giá trị biểu hiện (float)     →    Byte grayscale
─────────────────────────────────────────────────
vmin = 0.96 (thấp nhất)      →    1   (tối nhất, nhưng khác 0)
vmax = 4.79 (cao nhất)       →    255 (sáng nhất)
NaN / không có dữ liệu       →    0   (null — shader sẽ bỏ qua)
```

**Công thức:** `byte = (giá_trị - vmin) / (vmax - vmin) × 254 + 1`

```
┌──────── Mã hóa grayscale ────────┐
│                                    │
│  Giá trị:  0.96    2.5    4.79     │
│  Chuẩn hóa: 0.0    0.49    1.0     │
│  Byte:      1      125    255      │
│  Ý nghĩa:  vmin   giữa   vmax      │
│  Màu:      ████   ████   ████      │
│           (tối)         (sáng)     │
│                                    │
│  Byte 0 = null (padding) → bỏ qua  │
└────────────────────────────────────┘
```

**Vì sao byte 0 = null?** Ô cuối mỗi hàng/cột có thể không đủ 256 pixel dữ liệu — phần thiếu được đệm bằng 0. Shader thấy byte 0 → `discard` (không vẽ) → nền đen xuyên qua.

### Xử lý ô biên (edge tiles)

```
Cấp 2: 659 tế bào, mỗi ô 256 pixel
→ Cột 0: pixel 0–255   (đầy đủ)
→ Cột 1: pixel 256–511 (đầy đủ)
→ Cột 2: pixel 512–658 (CHỈ 147 pixel dữ liệu, 109 pixel = padding 0)

┌────────────────────────────────────────┐
│  Ô 0_2.png (256×256):                  │
│  ┌──────────────┬───────────────────┐  │
│  │  Dữ liệu     │  Padding (byte 0) │  │
│  │  (147 cột)   │  (109 cột = null) │  │
│  │  tô màu      │  → shader bỏ qua  │  │
│  └──────────────┴───────────────────┘  │
└────────────────────────────────────────┘
```

**Cải tiến mới:** Shader giờ dùng `dataExtent` để **chỉ lấy phần dữ liệu** và kéo giãn lấp đầy toàn bộ ô → không còn dải đen.

### Cache eviction (tự động dọn dẹp)

Disk cache (`diskcache` library) tự động quản lý dung lượng:

- **LRU (Least Recently Used):** Khi cache đầy (20 GB), tự động xóa ô lâu nhất
- **TTL 24h:** Ô không được truy cập trong 24h → tự động hết hạn
- **Không cần xóa tay:** Không như v0.1 (phải `shutil.rmtree` thư mục ô), cache tự dọn

```python
# backend/config.py
CACHE_MAX_SIZE = 20 * 10**9   # 20 GB
CACHE_TTL = 86400             # 24 giờ
```

> **Lưu ý:** `generate_pyramid.py` (tạo PNG tĩnh) vẫn còn cho **dataset nhỏ** (< 2M tế bào) làm fallback/legacy. Nhưng dynamic tile + cache là **đường mặc định** từ v0.2.

### Ưu điểm
- **Không tạo trước hàng triệu file** → tiết kiệm inode, build nhanh
- Disk cache = phục vụ ô đã render nhanh như file tĩnh (đọc SSD)
- Tự động eviction (LRU + TTL) → không cần dọn tay
- Trình duyệt tự cache HTTP (Cache-Control header)

### Nhược điểm
- Ô chưa cache → render lần đầu tốn vài ms (Zarr read + PNG encode)
- Cần SSD nhanh cho cache (HDD sẽ chậm khi nhiều ô)
- Ô biên có padding (đã xử lý bằng `dataExtent`)

---

## Bước 5: Máy chủ phục vụ ảnh (FastAPI Server)

### Ý tưởng

Một máy chủ HTTP **async** (FastAPI) làm **trạm render + cache** — trình duyệt yêu cầu ô nào, máy chủ render từ Zarr (hoặc lấy từ disk cache), trả về PNG.

```
Trình duyệt:  POST /api/tile  body: {"level":2,"row":0,"col":2}
                     ↓
Máy chủ:      1. Kiểm tra disk cache → có? → trả ngay
              2. Không? → đọc Zarr → render PNG → cache → trả
                     ↓
               Trả về PNG (256×256 grayscale, async)
```

### Vì sao cần bước này?

- Trình duyệt không thể đọc file trực tiếp từ đĩa máy chủ
- Cần API để trình duyệt hỏi "metadata" (kích thước, số cấp, cụm)
- **Async** để phục vụ nhiều ô song song (deck.gl tải hàng trăm ô cùng lúc)
- Cần **lazy metadata** (`/api/obs/range`) cho 20M tế bào — không trả toàn bộ
- Máy chủ cũng tạo **kim tự tháp tùy chỉnh** (out-of-core cho 20K gen)

### Các endpoint (đường dẫn API)

```
POST /api/datasets             → Liệt kê heatmap có sẵn (body: {})
POST /api/meta                 → Siêu dữ liệu (body: dataset_id?)
POST /api/tile                 → Dynamic tile (body: dataset_id?, level, row, col)  ← MẶC ĐỊNH
GET  /tiles/{level}/{row}_{col}.png → Static PNG (legacy, dataset nhỏ)
POST /api/obs                  → Toàn bộ metadata tế bào (chỉ < 1M cells, body: dataset_id?)
POST /api/obs/range            → Metadata cho range [start, end)  ← LAZY (body: dataset_id?, start, end)
POST /api/var                  → Tên gen (body: dataset_id?)
POST /api/groups               → Danh sách cụm (id + kích thước, body: dataset_id?)
POST /api/value                → Giá trị 1 ô (body: dataset_id?, cell, gene)
POST /api/cell_order           → Mảng hoán vị tế bào (body: dataset_id?)
POST /api/cache/stats          → Thống kê disk cache + registry (body: dataset_id?)
POST /api/custom               → Tạo kim tự tháp tùy chỉnh (body: dataset_id?, gene_indices)
POST /api/custom/tile          → Ảnh ô của kim tự tháp tùy chỉnh (body: cid, level, row, col)
POST /api/custom/meta          → Metadata kim tự tháp tùy chỉnh (body: cid)
POST /api/custom/var           → Tên gen của kim tự tháp tùy chỉnh (body: cid)
```

> **Lưu ý:** `dataset_id` là optional trong tất cả body (default = "default").
> Khi user chọn heatmap khác, frontend gọi `setDatasetId(id)` → tất cả POST
> body tự động kèm `dataset_id` → backend `registry.get(dataset_id)` mở đúng zarr.

> **Thay đổi v0.2:**
> - Tất cả API từ client dùng **POST** (JSON body), không dùng GET path/query params
> - `/api/tile` (POST body: level, row, col) là endpoint **mặc định** (dynamic + cache), thay thế `/tiles/...png` tĩnh
> - `/api/obs` trả **413 Payload Too Large** khi dataset ≥ 1M tế bào → buộc dùng `/api/obs/range`
> - `/api/obs/range` mới: chỉ trả metadata cho vùng đang xem (lazy)
> - `/api/cell_order` đọc từ Zarr (không phải meta.json)
> - `/api/cache/stats` mới: giám sát hit rate
> - **TileLoader** (frontend): POST tile → ArrayBuffer → blob URL (LRU cache) cho deck.gl BitmapLayer

```
┌───────────── Luồng phục vụ ảnh (v0.2) ─────────────┐
│                                                      │
│  Trình duyệt                                         │
│     │                                                │
│     │  POST /api/tile (level=2,row=0,col=2)         │
│     ↓                                                │
│  Vite Dev Proxy (chuy tiếp đến :8001)               │
│     │                                                │
│     ↓                                                │
│  FastAPI async (server.py)                           │
│     │                                                │
│     │  asyncio.to_thread(_serve_tile_sync)           │
│     ↓                                                │
│  tile_cache.get_or_render("t/2/0/2", render_fn)      │
│     │                                                │
│     ├── Cache HIT → trả PNG ngay                     │
│     └── Cache MISS → Zarr[0:256, 0:256] → render PNG │
│         → lưu cache → trả PNG                        │
│     │                                                │
│     ↓                                                │
│  Trình duyệt nhận PNG → vẽ lên canvas                │
│                                                      │
└──────────────────────────────────────────────────────┘
```

### POST + TileLoader — Tại sao không dùng GET cho tile (v0.2)

deck.gl's `BitmapLayer` nhận prop `image` là một **URL string** (hoặc Image/Texture).
Trước đây (v0.1) tile được phục vụ qua `GET /api/tile/{L}/{R}/{C}` → URL trực tiếp
vào `image` prop, deck.gl tự tải ảnh. Nhưng khi chuyển tất cả API sang POST, URL
không còn dùng được — POST không có URL để deck.gl fetch.

**Giải pháp: TileLoader** — một lớp trung gian trên frontend:

```
┌──────────── TileLoader — POST → blob URL → deck.gl ────────────┐
│                                                                 │
│  1. getSync({level, row, col})                                  │
│     ├── Cache HIT → trả blob URL ngay (đồng bộ)                │
│     └── Cache MISS → trả null + kích hoạt async fetch          │
│                                                                 │
│  2. Async fetch (nền):                                          │
│     POST /api/tile {level, row, col}                            │
│       → ArrayBuffer (PNG bytes)                                 │
│       → Blob([buf], {type:"image/png"})                         │
│       → URL.createObjectURL(blob) → "blob:http://.../abc-123"  │
│       → Lưu vào LRU cache (Map)                                 │
│       → onLoad() callback → bump tileVersion → React re-render │
│                                                                 │
│  3. Re-render tiếp theo:                                        │
│     getSync() trả blob URL (đã cache) → deck.gl vẽ ảnh         │
│                                                                 │
│  4. LRU eviction:                                               │
│     Cache > 2000 entry → revoke URL cũ (URL.revokeObjectURL)   │
│     → giải phóng RAM (~256KB/blob × 2000 = ~500MB max)        │
│                                                                 │
│  5. Dedup: cùng tile đang fetch → trả cùng Promise             │
│     → không POST trùng lặp khi deck.gl render nhiều frame      │
└─────────────────────────────────────────────────────────────────┘
```

```typescript
// client/src/TileLoader.ts
export class TileLoader {
  private cache = new Map<string, CacheEntry>();     // LRU blob URLs
  private inFlight = new Map<string, Promise<string>>(); // dedup

  async get(params: TileParams): Promise<string> {
    // 1. Cache hit? → trả ngay
    // 2. In-flight? → trả cùng promise (dedup)
    // 3. POST fetch → ArrayBuffer → Blob → createObjectURL → cache → onLoad()
  }

  getSync(params: TileParams): string | null {
    // Trả cached URL ngay, hoặc null + trigger async fetch
    // Dùng trong render — deck.gl nhận URL hoặc null (bỏ qua nếu null)
  }
}
```

```typescript
// client/src/HeatmapTileLayer.ts — createTileLayers()
const imageUrl = tileLoader.getSync({ level, row, col });
// → cached blob URL hoặc null (chưa load xong)
const props = { image: imageUrl, ... };
// → deck.gl BitmapLayer: có URL thì vẽ, null thì bỏ qua frame này
```

**Tại sao POST thay vì GET?**
- **Bảo mật**: tham số trong body, không hiện trên URL/logs
- **Không giới hạn độ dài**: GET URL có giới hạn ~2KB, POST body không
- **Đồng nhất**: tất cả API dùng cùng method, dễ debug + middleware
- **Cache control**: GET bị browser/CDN cache tự động (có thể không mong muốn
  với dynamic tiles); POST không bị cache tự động → luôn fetch mới

**Tại sao blob URL thay vì data URL?**
- `data:` URL nhúng base64 vào chuỗi → tăng 33% kích thước + chậm parse
- `blob:` URL tham chiếu đến bytes gốc → không overhead, deck.gl load nhanh

#### Blob URL có ảnh hưởng performance không?

**Ngắn gọn: gần như KHÔNG.** Overhead chính là 1 re-render (~1ms) khi tile
load xong. Network latency (5-20ms/tile) vẫn là bottleneck, blob URL chỉ
thêm <1% overhead.

```
POST request ──→ ArrayBuffer ──→ createObjectURL ──→ onLoad ──→ re-render ──→ deck.gl vẽ
  ~5-20ms         ~0ms            ~0.001ms          ~1ms        ~0.1ms
  ↑↑↑                                                        ↑↑
  bottleneck chính                                    overhead duy nhất
```

| Khía cạnh | GET URL (cũ) | POST + Blob URL (mới) |
|---|---|---|
| Tạo URL | 0 (URL là string) | ~μs (`createObjectURL`) |
| Decode PNG | Giống nhau (deck.gl decode) | Giống nhau |
| Cache control | Browser HTTP cache (không kiểm soát) | LRU cache tự quản lý (`Map`) |
| Memory | Browser tự quản | Giữ bytes trong RAM đến khi `revokeObjectURL` |
| Re-render | deck.gl tự load async (0 re-render) | Cần 1 re-render khi tile load xong (`onLoad`) |
| Dedup | Browser tự dedup HTTP | `inFlight` Map tự dedup |

**Hai vấn đề thực sự (nhỏ):**

1. **Re-render khi tile load xong** — Với GET, deck.gl tự load async và vẽ
   khi sẵn sàng (0 re-render). Với POST + blob, `getSync()` trả `null` khi
   chưa cache, rồi `onLoad()` bump `tileVersion` → re-render. Có thể gây
   flicker nhẹ ở frame đầu. **Giải pháp**: debounce `onLoad` về 16ms (1
   frame) để batch nhiều tile.

2. **Memory ~20-100MB** — Mỗi blob URL giữ PNG bytes cho đến khi revoke.
   256×256 grayscale PNG nén ~10-50KB. LRU 2000 entries → 20-100MB.
   `evictLRU()` giải phóng khi vượt max, nhưng nếu pan nhanh, nhiều tile
   load cùng lúc trước khi evict kịp. **Giải pháp**: giảm `maxEntries` hoặc
   dùng `createImageBitmap` thay blob URL.

**Tối ưu tối đa (nếu cần):** Thay blob URL bằng `createImageBitmap(blob)`
và truyền thẳng cho deck.gl — bỏ hoàn toàn re-render và blob URL:

```typescript
// Thay vì: const url = URL.createObjectURL(blob);  // cần re-render
// Dùng:    const bitmap = await createImageBitmap(blob);  // deck.gl vẽ ngay
// → BitmapLayer chấp nhận ImageBitmap object làm `image` prop
// → không cần onLoad, không cần re-render, không cần revoke
```

### PyramidRegistry — Đa heatmap (v0.3)

Khi app có **nhiều heatmap** (mỗi analysis là 1 zarr riêng), mở 1
`PyramidStore` cố định là không hợp lý. `PyramidRegistry` quản lý nhiều
store với **LRU + TTL + explicit + shutdown cleanup**:

```
┌─────────── PyramidRegistry (backend/pyramid_registry.py) ───────────┐
│                                                                       │
│  data/                                                                │
│  ├── heatmap.zarr/          → dataset_id = "default" (legacy)        │
│  ├── GSE145926.zarr/        → dataset_id = "GSE145926"               │
│  ├── RP-01KXQQVM0C7A5ZKNDBZKSDRXEY.zarr/ → dataset_id = "RP-..."    │
│  └── ...                                                              │
│                                                                       │
│  Discovery: quét REGISTRY_DIR, tìm *.zarr có meta.json               │
│  → heatmap.zarr → "default", các *.zarr khác → tên thư mục           │
│                                                                       │
│  Registry.get(dataset_id):                                            │
│  ├── Store đã mở? → trả ngay + bump last_access (LRU)               │
│  ├── Store chưa mở? → evict expired (TTL) → evict LRU → open mới    │
│  └── Store không tồn tại? → KeyError (404)                          │
│                                                                       │
│  Cleanup (4 chiến lược):                                             │
│  ├── LRU eviction: > max_open store → đóng store cũ nhất           │
│  ├── TTL expiry: store idle > ttl giây → đóng ở lần truy cập sau    │
│  ├── Explicit: registry.close("GSE145926") → đóng 1 store          │
│  └── Shutdown: registry.close_all() → đóng tất cả (FastAPI lifespan)│
│                                                                       │
│  Mặc định: max_open=4, ttl=1800s (30 phút)                           │
│  → Tối đa 4 zarr mở cùng lúc, idle 30 phút thì đóng                  │
│  → Mỗi store ~MB (zarr handles + metadata), không nổ RAM           │
└───────────────────────────────────────────────────────────────────────┘
```

```python
# backend/pyramid_registry.py
class PyramidRegistry:
    def __init__(self, registry_dir, max_open=4, ttl=1800):
        self._open: dict[str, {"store": PyramidStore, "last_access": float}] = {}
        self._paths: dict[str, Path] = {}  # dataset_id → zarr path
        self._discover()  # quét thư mục tìm *.zarr

    def get(self, dataset_id: str | None = None) -> PyramidStore:
        # 1. None → "default"
        # 2. Store đã mở? → bump last_access, trả ngay
        # 3. Chưa mở? → evict_expired() → evict_lru() → open + cache
        # 4. Không tồn tại? → KeyError

    def _evict_expired(self):  # TTL: đóng store idle > ttl
    def _evict_lru(self):     # LRU: đóng store cũ nhất nếu > max_open
    def close(self, ds_id):   # Explicit: đóng 1 store
    def close_all(self):      # Shutdown: đóng tất cả
```

```python
# backend/server.py — tất cả endpoint dùng registry.get(dataset_id)
@app.post("/api/tile")
async def get_tile(req: TileRequest):
    store = registry.get(req.dataset_id)  # ← chọn zarr theo dataset_id
    png = await asyncio.to_thread(_serve_tile_sync, store, ...)
    return Response(content=png, media_type="image/png")
```

```typescript
// client/src/api.ts — tất cả POST body kèm dataset_id
let _datasetId: string | null = null;
function _body(extra) { return _datasetId ? { dataset_id: _datasetId, ...extra } : extra; }

// POST /api/tile  body: { dataset_id, level, row, col }
// POST /api/meta  body: { dataset_id }
// POST /api/obs   body: { dataset_id }
// → backend registry.get(dataset_id) → đúng zarr store
```

```typescript
// client/src/HeatmapView.tsx — dataset selector dropdown
const [datasets, setDatasets] = useState<DatasetInfo[]>([]);
const [activeDatasetId, setActiveDatasetId] = useState<string | null>(null);

// Mount: fetchDatasets() → populate dropdown → auto-select "default"
// Switch: setDatasetId(id) → clear tile cache → refetch meta/var/groups/obs
```

**Endpoint mới:**

```
POST /api/datasets  body: {}  → { datasets: [{ id, path }, ...] }
```

> **Thay đổi v0.3:**
> - `PyramidRegistry` thay thế `_store` đơn — hỗ trợ nhiều heatmap
> - Tất cả POST body thêm `dataset_id` (optional, default = "default")
> - `POST /api/datasets` mới — liệt kê heatmap có sẵn trên đĩa
> - Frontend: dropdown chọn dataset, tự động refetch metadata khi switch
> - LRU + TTL + explicit + shutdown cleanup — không nổ RAM/file handles
> - `@app.on_event("shutdown")` → `registry.close_all()` — đóng sạch zarr

### Kim tự tháp tùy chỉnh — Out-of-core (v0.2)

Khi người dùng chọn một tập gen cụ thể, máy chủ tạo **kim tự tháp tùy chỉnh**. Trước đây (v0.1) load toàn bộ level_0 vào RAM. Giờ (v0.2) có hai đường:

- **`_build_small()`** (< 2K gen): load subset vào RAM, dask pyramid — nhanh
- **`_build_large()`** (≥ 2K gen): **out-of-core** — stream từng hàng gen từ level_0, ghi vào per-custom Zarr, rồi dask pyramid

```python
# backend/server.py — CustomPyramid._build_large()
# Stream gene rows từ level_0 → per-custom zarr (không load toàn bộ)
for g_start in range(0, n_sel, 256):
    g_end = min(g_start + 256, n_sel)
    rows = arr0[idx[g_start:g_end], :]   # Đọc 256 hàng gen
    out_z[g_start:g_end, :] = rows       # Ghi vào zarr tùy chỉnh
# Dask pyramid coarsening (out-of-core)
```

Cache cleanup: kim tự tháp tùy chỉnh cũ tự xóa sau 30 phút (TTL) để tiết kiệm đĩa.

### Ưu điểm
- **Async** phục vụ hàng trăm ô song song (không chặn event loop)
- Disk cache = ô đã render nhanh như file tĩnh
- Lazy metadata (`/api/obs/range`) → browser không OOM với 20M tế bào
- Out-of-core custom pyramid → chọn 20K gen không nổ RAM
- Proxy Vite = cùng nguồn (no CORS issues)

### Nhược điểm
- Phải chạy máy chủ riêng (không thể mở file HTML trực tiếp)
- Ô chưa cache → render lần đầu tốn vài ms
- Cần SSD cho cache (HDD chậm khi nhiều ô)

---

## Bước 6: Trình duyệt tải và hiển thị (Frontend)

### Ý tưởng

Trình duyệt dùng **deck.gl** (thư viện vẽ dữ liệu địa không gian) để vẽ heatmap. deck.gl chia canvas thành các **lớp (layers)** xếp chồng lên nhau:

```
┌───────── Cấu trúc lớp (từ dưới lên trên) ─────────┐
│                                                    │
│  Lớp 1: Ô heatmap (GroupedHeatmapLayer)            │
│         → Vẽ ảnh grayscale + tô màu qua LUT        │
│                                                    │
│  Lớp 2: Khe cụm (Gap overlay)                     │
│         → Hình chữ nhật đen che vết rò rỉ biên     │
│                                                    │
│  Lớp 3: Viền ô (Tile border)                       │
│         → Khung viền + hover thông tin ô            │
│                                                    │
│  Lớp 4: Chú thích cụm (Cluster annotation)        │
│         → Gạch chân + tên cụm phía trên             │
│                                                    │
│  Lớp 5: Nhãn trục (Axis labels)                    │
│         → Tên tế bào (dưới) + tên gen (trái)        │
│                                                    │
└────────────────────────────────────────────────────┘
```

### Vì sao cần deck.gl?

- **WebGL** vẽ hàng nghìn ô ở 60 FPS (CPU không làm được)
- Tự động **loại bỏ (culling)** ô ngoài khung nhìn
- Quản lý **cache** ảnh ô
- Hỗ trợ **pan/zoom** mượt

### Chọn ô nhìn thấy (Tile Culling) — Index-based (v0.2)

Mỗi khung hình, tính toán ô nào nằm trong khung nhìn. **Trước đây** (v0.1) quét toàn bộ `nRows × nCols` ô ở cấp đã chọn (với 20M tế bào = 78K cột × 200 hàng = 15,6M ô → quá chậm). **Giờ** (v0.2) dùng **binary search** để tìm trực tiếp range ô trong khung nhìn:

```
┌───────── Index-based culling (v0.2) ──────────┐
│                                                │
│    Khung nhìn (viewport)                       │
│  ┌────────────────────────┐                   │
│  │ ████ ████ ████ ████    │ ← Chỉ tải ô       │
│  │ ████ ████ ████ ████    │   trong khung      │
│  │ ████ ████ ████ ████    │                   │
│  └────────────────────────┘                   │
│    ↑ Ô ngoài khung = KHÔNG tải                 │
│                                                │
│  Thuật toán (binary search):                   │
│  - Trục Y: floor/ceil trực tiếp → [r0, r1]     │
│  - Trục X: _findFirstTileColInViewport()      │
│           + _findLastTileColInViewport()       │
│           → binary search qua cluster gaps    │
│  - Chỉ duyệt [r0..r1] × [c0..c1] + reject     │
│                                                │
│  O(log n + kết quả) thay vì O(nRows×nCols)    │
└────────────────────────────────────────────────┘
```

```typescript
// client/src/HeatmapTileLayer.ts — computeVisibleTiles()
// Trục Y: trực tiếp
const r0 = Math.floor(worldTop / tileSize);
const r1 = Math.ceil(worldBottom / tileSize);
// Trục X: binary search (khi có cluster gaps)
const c0 = _findFirstTileColInViewport(layout, worldLeft, level);
const c1 = _findLastTileColInViewport(layout, worldRight, level);
// Chỉ duyệt range [r0..r1] × [c0..c1]
for (let r = r0; r <= r1; r++)
  for (let c = c0; c <= c1; c++)
    // ... reject nếu ngoài khung
```

### Chọn cấp kim tự tháp (Level Selection)

```
Zoom = 0   (xem toàn bộ)  → Cấp 8 (thô nhất, 10×196)
Zoom = -4  (zoom ra)      → Cấp 4
Zoom = -8  (xa nhất)       → Cấp 8
Zoom = +2  (zoom vào)     → Cấp 0 (chi tiết nhất)

Công thức: level = floor(-zoom), giới hạn [0, maxLevel]
```

### Sắp xếp ô với khe cụm (SpatialLayout) — RTC (v0.2)

```
┌─────── SpatialLayout: khe giữa các cụm ───────┐
│                                                │
│  Không khe (raw):     Có khe (world):          │
│  ┌────┬──┬───┐       ┌────┐ ┌──┐ ┌───┐       │
│  │ C1 │C2│C3 │       │ C1 │ │C2│ │C3 │       │
│  │    │  │   │       │    │ │  │ │   │       │
│  └────┴──┴───┘       └────┘ └──┘ └───┘       │
│  0   1144 1624      0  1144  gap 1624  gap   │
│                       ← groupWorldStarts →     │
│                       ← groupRawStarts →       │
│                                                │
│  Hai mảng riêng biệt:                          │
│  - groupRawStarts: vị trí gốc (không khe)      │
│  - groupWorldStarts: vị trí màn hình (có khe)  │
│                                                │
│  Tại sao tách? Trộn chúng = ô đặt sai vị trí!  │
└────────────────────────────────────────────────┘
```

**Thay đổi v0.2 — RTC (Relative-To-Center):** Với 20M tế bào, tổng chiều rộng world có thể lên tới **20 triệu pixel**. Float32 (độ chính xác ~7 chữ số) bắt đầu **jitter** ở tọa độ > 16,7 triệu → ô nhảy lung tung khi zoom.

Giải pháp: **dịch tọa độ về gần 0** bằng `coordinateOrigin` trong deck.gl OrthographicView:

```typescript
// client/src/HeatmapView.tsx
const absWorldWidth = activeGroups.reduce((w, g) => w + g.size + gap, 0);
const needsRTC = meta.n_cells >= 1_000_000;       // ≥ 1M → dùng RTC
const originX = needsRTC ? absWorldWidth / 2 : 0;  // Dịch về giữa

// SpatialLayout dùng tọa độ tương đối (relative to originX)
const layout = new SpatialLayout(activeGroups, gapSize, originX);
// → groupWorldStarts, totalWorldWidth đều relative

// DeckGL view: coordinateOrigin = [originX, 0, 0]
<OrthographicView
  coordinateOrigin={[originX, 0, 0]}           // Dịch gốc tọa độ
  coordinateSystem={COORDINATE_SYSTEM.CARTESIAN}
/>
```

```
┌────────── RTC: Tọa độ tương đối ──────────┐
│                                            │
│  Tuyệt đối (jitter ở 20M):                │
│  0 ──────────── 10M ──────────── 20M     │
│  ↑                ↑ jitter!              │
│  originX = 10M                            │
│                                            │
│  Tương đối (ổn định):                     │
│  -10M ─────── 0 ─────── +10M             │
│  ↑              ↑ originX                 │
│  → Float32 đủ chính xác (< 16,7M)        │
│  → Không jitter khi zoom                  │
└────────────────────────────────────────────┘
```

### Lazy metadata fetch (v0.2)

Với 20M tế bào, tải toàn bộ `cell_ids` + `louvain` + `umap` = **hàng trăm MB JSON** → browser OOM. Thay vào đó, chỉ tải metadata cho **vùng đang xem**:

```typescript
// client/src/HeatmapView.tsx
const VISIBLE_CELL_LABEL_THRESHOLD = 5000;

useEffect(() => {
  const nVisible = endCol - startCol;
  if (nVisible > VISIBLE_CELL_LABEL_THRESHOLD) return; // Quá nhiều → bỏ qua
  if (nVisible === lastObsRangeRef.current) return;    // Đã fetch → bỏ qua
  lastObsRangeRef.current = nVisible;
  fetchObsRange(startCol, endCol).then(setObsData);    // Lazy fetch
}, [startCol, endCol]);
```

```
┌────── Lazy metadata: chỉ tải vùng xem ──────┐
│                                              │
│  Zoom xa (20M cells visible):               │
│  → nVisible > 5000 → KHÔNG fetch            │
│  → Không hiện nhãn tế bào (quá dày)         │
│                                              │
│  Zoom vào (2K cells visible):               │
│  → nVisible ≤ 5000 → fetchObsRange()        │
│  → POST /api/obs/range {start:18000, end:20000}   │
│  → Chỉ 2K cell_ids (~50 KB)                 │
│  → Hiện nhãn tế bào                         │
└──────────────────────────────────────────────┘
```

### Ưu điểm
- WebGL = 60 FPS với hàng nghìn ô
- **Index-based culling** = O(log n), không quét 15,6M ô
- **RTC** = không jitter Float32 ở 20M tế bào
- **Lazy metadata** = browser không OOM
- Pan/zoom mượt

### Nhược điểm
- deck.gl phức tạp, đường cong học tập cao
- Shader tùy chỉnh khó debug
- Phải quản lý nhiều lớp thủ công
- RTC + lazy fetch thêm logic phức tạp

---

## Bước 7: Tô màu trên GPU (Shader)

### Ý tưởng

Ảnh PNG từ máy chủ là **grayscale** (đen trắng). Trình duyệt dùng **shader** (chương trình chạy trên card đồ họa) để **tra cứu màu** từ một **bảng màu (LUT — Lookup Table)** 256×1 pixel.

```
┌───────────── Tô màu trên GPU ─────────────┐
│                                            │
│  Ảnh grayscale     Bảng màu (LUT)          │
│  (từ máy chủ)      (256×1 pixel)           │
│                                            │
│  Byte: 1    ──→   ████  (tím tối)          │
│  Byte: 64   ──→   ████  (xanh dương)       │
│  Byte: 128  ──→   ████  (xanh lá)          │
│  Byte: 200  ──→   ████  (vàng)             │
│  Byte: 255  ──→   ████  (vàng sáng)        │
│  Byte: 0    ──→   discard (bỏ qua)         │
│                                            │
│  LUT là texture 256×1:                     │
│  ┌──┬──┬──┬──┬──┬── ... ──┬──┐             │
│  │  │  │  │  │  │         │  │             │
│  └──┴──┴──┴──┴──┴── ... ──┴──┘             │
│  0  0.1 0.2 ...         1.0                 │
│  ← viridis palette →                       │
└────────────────────────────────────────────┘
```

### Vì sao tô màu trên GPU?

| Cách cũ (CPU) | Cách này (GPU) |
|---|---|
| Tạo ảnh RGB trên máy chủ | Tạo ảnh grayscale trên máy chủ |
| Đổi màu = tạo lại tất cả ảnh | Đổi màu = đổi texture LUT (0ms) |
| Tốn CPU + băng thông | Tốn GPU (song song hàng triệu pixel) |
| 4 palette × tất cả ô = 4× dung lượng | 1 ảnh grayscale + 4 LUT nhỏ |

### Chi tiết shader

```glsl
// GroupedHeatmapLayer.ts — fragment shader (chạy trên GPU)

void main(void) {
  vec2 uv = vTexCoord;
  uv = uv * heatmap.dataExtent;  // Chỉ lấy phần dữ liệu (ô biên)

  // 1. Đọc byte grayscale (0-255) từ ảnh ô
  float grayByte = texture(bitmapTexture, uv).r * 255.0;

  // 2. Bỏ qua pixel null (byte 0 = padding)
  if (grayByte <= 0.5) { discard; }

  // 3. Ánh xạ byte 1-255 → LUT 0-1
  //    Byte 1 (thấp nhất) → LUT 0 (đầu palette)
  //    Byte 255 (cao nhất) → LUT 1 (cuối palette)
  float lutT = clamp((grayByte - 1.0) / 254.0, 0.0, 1.0);

  // 4. Tra màu từ LUT
  vec4 color = texture(colorMapLUT, vec2(lutT, 0.5));
  fragColor = vec4(color.rgb, color.a * layer.opacity);
}
```

### Bảng màu (LUT)

4 palette có sẵn, mỗi palette là 256 màu nội suy từ các điểm kiểm soát:

```
┌─────────── 4 Palette ───────────┐
│                                  │
│  Viridis:  ████░░▓▓▓██████      │  (tím → xanh → lục → vàng)
│  Magma:    ████░░▓▓▓██████      │  (đen → tím → đỏ → vàng)
│  Plasma:   ████░░▓▓▓██████      │  (tím → hồng → cam → vàng)
│  Inferno:  ████░░▓▓▓██████      │  (đen → tím → cam → vàng sáng)
│                                  │
│  Đổi palette = đổi texture LUT  │
│  → Tức thì, không tải lại ảnh!  │
└──────────────────────────────────┘
```

### Ưu điểm
- Đổi màu tức thì (0ms) — chỉ đổi texture 256×1
- GPU song song = hàng triệu pixel/giây
- 1 ảnh grayscale phục vụ tất cả palette

### Nhược điểm
- Shader khó viết và debug
- Phải xử lý edge case (byte 0, dataExtent)
- Phụ thuộc WebGL2 (trình duyệt cũ không hỗ trợ)

---

## Bước 8: Tương tác người dùng (Zoom, Pan, Hover)

### Ý tưởng

Người dùng có thể:

1. **Zoom** (cuộn chuột) — chọn cấp kim tự tháp + tải ô phù hợp
2. **Pan** (kéo) — di chuyển khung nhìn, tải ô mới
3. **Hover** (di chuột lên ô) — hiện thông tin ô (cấp, hàng, cột, tọa độ)
4. **Kéo thanh trượt Gap** — thay đổi khe giữa các cụm
5. **Đổi palette** — chuyển bảng màu tức thì
6. **Chọn gen** — tạo kim tự tháp tùy chỉnh cho gen đã chọn
7. **Box-select zoom** (kéo vùng chữ nhật) — chọn 1 vùng trên heatmap để zoom in

### Luồng zoom

```
┌─────────── Luồng Zoom (v0.2) ────────────┐
│                                          │
│  1. Người dùng cuộn chuột               │
│       ↓                                  │
│  2. deck.gl cập nhật viewState.zoom     │
│       ↓                                  │
│  3. computeVisibleTiles() chạy:         │
│     - Tính cấp = floor(-zoom)           │
│     - Index-based culling (binary search)│
│     - Áp dụng khe cụm (SpatialLayout+RTC)│
│       ↓                                  │
│  4. Tạo GroupedHeatmapLayer mỗi ô       │
│       ↓                                  │
│  5. Mỗi layer POST /api/tile (dynamic)  │
│     → disk cache hit? trả ngay          │
│     → miss? render from zarr → cache    │
│       ↓                                  │
│  6. fetchObsRange() nếu < 5K cells      │
│     → lazy metadata cho nhãn trục       │
│       ↓                                  │
│  7. GPU shader tô màu + vẽ             │
│       ↓                                  │
│  8. Heatmap cập nhật (60 FPS)          │
│                                          │
└──────────────────────────────────────────┘
```

### Hover ô

```
┌────────── Hover lên ô ──────────┐
│                                   │
│  Di chuột lên ô →                 │
│  ┌─────────────────────┐          │
│  │ ████ ← ô được tô    │          │
│  │ ████   viền sáng    │          │
│  └─────────────────────┘          │
│       ↓                           │
│  Tooltip hiện:                    │
│  ┌──────────────────────┐        │
│  │ Tile: level 2, row 0  │        │
│  │       col 2           │        │
│  │ Bounds: [512,0]→      │        │
│  │   [1024,512]          │        │
│  │ Size: 512 × 512       │        │
│  └──────────────────────┘        │
│                                   │
└───────────────────────────────────┘
```

### Box-select zoom (kéo vùng để zoom in)

Người dùng có thể **kéo một hình chữ nhật** trên heatmap để zoom vào vùng đó
nhanh chóng — thay vì phải cuộn chuột nhiều lần.

```
┌────────── Box-select zoom ──────────┐
│                                       │
│  1. Bấm nút "▢ Select region"        │
│     → Bật chế độ box-select           │
│     → Con trỏ = crosshair (chữ thập) │
│                                       │
│  2. Kéo chuột trên heatmap:           │
│  ┌──────────────────────┐             │
│  │ ┌─────┐              │ ← Vùng chọn │
│  │ │     │  (xanh nhạt) │   (drag)    │
│  │ └─────┘              │             │
│  └──────────────────────┘             │
│                                       │
│  3. Thả chuột:                        │
│     → Tính world bounds từ 4 góc     │
│     → Zoom + pan đến vùng chọn        │
│     → Tắt box-select (về pan/zoom bt) │
│                                       │
│  4. Bấm lại nút để tắt chế độ         │
│                                       │
└───────────────────────────────────────┘
```

**Cơ chế:**

- Khi bật box-select, một lớp overlay (`box-select-overlay`) phủ lên canvas,
  chặn sự kiện chuột để deck.gl không pan/zoom khi kéo.
- `screenToWorld()` chuyển tọa độ pixel màn hình → tọa độ world bằng công
  thức ngược của deck.gl OrthographicView:
  `world = (screen - viewport_center) / 2^zoom + target`
- Khi thả chuột, tính zoom mới = `log2(min(width/worldW, height/worldH))`
  để vùng chọn lấp đầy khung nhìn, rồi pan đến tâm vùng chọn.

```typescript
// client/src/HeatmapView.tsx — screenToWorld()
const screenToWorld = (sx, sy) => {
  const zoom = Number(viewState.zoom ?? 0);
  const [tx, ty] = viewState.target;
  const scale = Math.pow(2, zoom);
  const wx = (sx - size.width / 2) / scale + tx;
  const wy = (sy - size.height / 2) / scale + ty;
  return [wx, wy];
};

// Khi thả chuột:
const [wx0, wy0] = screenToWorld(x0, y0);
const [wx1, wy1] = screenToWorld(x1, y1);
const newZoom = Math.log2(
  Math.min(size.width / (wx1 - wx0), size.height / (wy1 - wy0))
);
setViewState({ target: [(wx0+wx1)/2, (wy0+wy1)/2, 0], zoom: newZoom });
```

> **Lưu ý:** Khi box-select bật, deck.gl controller tắt `dragPan` để kéo
> không bị xung đột với overlay. Zoom bằng cuộn chuột vẫn hoạt động. Kéo quá
> nhỏ (< 5px) bị bỏ qua (coi như click, không zoom).

### Ưu điểm
- Trải nghiệm mượt, tức thì
- Đổi palette/khe không tải lại ảnh
- Hover cho thông tin chi tiết
- Dynamic tile + cache = ô đã xem tải tức thì
- Lazy metadata = không OOM khi zoom xa 20M cells
- **Box-select zoom** = kéo vùng chữ nhật để zoom in nhanh

### Nhược điểm
- Phải quản lý state phức tạp (fit-once guard, LUT async, RTC origin, lazy obs)
- Tải ô động lần đầu (cache miss) có thể gây nhấp nháy khi mạng chậm

---

## Cách tính toán và hiển thị ô (Tile Computation & Display)

Phần trên giải thích từng bước riêng lẻ (render ô, culling, shader). Phần này
giải thích **toàn bộ hành trình của một ô** từ con số trong Zarr đến pixel màu
trên màn hình — cụ thể: ô được **tính toán** thế nào (kích thước, padding,
dataExtent, chọn cấp) và **hiển thị** ra sao (shader kéo giãn, mã hóa
grayscale, tra LUT, căn nhãn trục).

### A. Cấu trúc ô — Luôn 256×256 pixel

Mọi ô PNG mà máy chủ trả về đều **chính xác 256×256 pixel grayscale** (1 byte/pixel), bất kể cấp kim tự tháp hay vị trí:

```
┌─────────── Cấu trúc ô 256×256 ───────────┐
│                                            │
│  Ma trận ở cấp L:  shape = (h_L, w_L)      │
│  Số ô theo hàng:   nRows = ceil(h_L / 256) │
│  Số ô theo cột:    nCols = ceil(w_L / 256) │
│                                            │
│  Ô (r, c) lấy khối Zarr:                   │
│    [r*256 : (r+1)*256, c*256 : (c+1)*256] │
│                                            │
│  Nếu khối nhỏ hơn 256 → đệm NaN → byte 0  │
│  → Mọi ô PNG vẫn là 256×256 pixel          │
│                                            │
│  Vì sao?                                    │
│  - Trình duyệt không cần biết kích thước  │
│    thật, chỉ load 1 URL, vẽ 1 texture     │
│  - GPU map 1:1 texture → world bounds      │
│  - Nearest filtering = pixel sắc nét       │
└────────────────────────────────────────────┘
```

> **Ví dụ** (GSE145926, 108.230 tế bào × 33.538 gen, 10 cấp):
> - Cấp 0: shape = (33.538, 108.230) → 131 hàng × 423 cột = 55.353 ô
> - Cấp 9 (thô nhất): shape = (66, 212) → 1 hàng × 1 cột = 1 ô (66 hàng dữ liệu + 190 hàng padding = byte 0)

### B. Mã hóa grayscale — 1 byte mang 3 ý nghĩa

Backend không tạo ảnh màu. Mỗi pixel là **1 byte (0–255)** với quy ước:

```
Giá trị biểu hiện (float)         Byte grayscale    Ý nghĩa
──────────────────────────────────────────────────────────────
vmin (thấp nhất thật)            1                  Tối nhất (nhưng ≠ 0)
vmax (cao nhất thật)             255                Sáng nhất
NaN / padding / không có dữ liệu 0                  NULL — shader discard

Công thức:  byte = clip((giá_trị - vmin) / (vmax - vmin), 0, 1) × 254 + 1
            NaN → 0
```

**Vì sao byte 0 = null, không phải byte 1?** Ô biên có thể chỉ chứa 147 pixel
dữ liệu + 109 pixel padding. Nếu padding cũng mã hóa thành byte 1 (giống
vmin), shader sẽ tô màu tối cho vùng không có dữ liệu → dải tối giả. Dành
byte 0 riêng cho null → shader `discard` (không vẽ) → nền đen xuyên qua.

```
┌──────── Mã hóa 3 vùng trong 1 ô 256×256 ────────┐
│                                                    │
│  Pixel 0–146:   dữ liệu thật → byte 1–255 (tô màu) │
│  Pixel 147–255: padding NaN  → byte 0   (discard) │
│                                                    │
│  Shader:  if (grayByte <= 0.5) { discard; }       │
│           → Vùng padding trong suốt hoàn toàn      │
└────────────────────────────────────────────────────┘
```

### C. dataExtent — Kéo giãn phần dữ liệu lấp đầy toàn ô

Vấn đề: ô biên chỉ có 147 pixel dữ liệu nhưng texture vẫn 256 pixel. Nếu
shader lấy UV nguyên vẹn `[0,1]`, 147 pixel dữ liệu sẽ chiếm 57% diện tích ô,
phần còn lại là padding → **dải tối** ở cạnh.

Giải pháp: mỗi ô mang theo `dataExtent = [uExtent, vExtent]` — **tỉ lệ phần
texture chứa dữ liệu thật** trên mỗi trục. Shader **remap UV** từ `[0,1]` vào
`[0, dataExtent]` để chỉ lấy phần dữ liệu rồi kéo giãn lấp đầy toàn bộ world
bounds:

```
┌──────── dataExtent: kéo giãn phần dữ liệu ────────┐
│                                                    │
│  Texture 256px:   ┌────────┬──────────┐           │
│                   │ Dữ liệu │ Padding  │           │
│                   │ (147px) │ (109px)  │           │
│                   └────────┴──────────┘           │
│                   ← uExtent = 147/256 = 0.574 →    │
│                                                    │
│  Shader remap:  uv = uv * dataExtent               │
│  → Chỉ lấy 57% đầu texture, bỏ 43% padding         │
│  → Kéo giãn 57% đó lấp đầy 100% world bounds       │
│                                                    │
│  Kết quả:                                          │
│  ┌──────────────────────┐  ← World bounds đầy đủ  │
│  │                      │    (không dải tối)      │
│  │  Dữ liệu kéo giãn    │                         │
│  │  lấp đầy toàn ô      │                         │
│  └──────────────────────┘                         │
└────────────────────────────────────────────────────┘
```

```typescript
// client/src/HeatmapTileLayer.ts — computeVisibleTiles()
// Tỉ lệ dữ liệu trên trục X (cột/cells):
const uExtent = Math.min(1, (w - c * TILE) / TILE);
// Tỉ lệ dữ liệu trên trục Y (hàng/genes):
const vExtent = Math.min(1, (h - r * TILE) / TILE);
// Ô nội bộ: [1, 1] (đầy đủ)
// Ô biên:   < 1 trên trục bị cắt
```

```glsl
// client/src/GroupedHeatmapLayer.ts — fragment shader
uv = uv * heatmap.dataExtent;   // Remap [0,1] → [0, dataExtent]
// → Chỉ lấy phần dữ liệu, padding không bao giờ được sample
```

### D. Trường hợp đặc biệt: ít gen (< 256) — Kéo giãn toàn trục Y

Khi người dùng chọn **ít gen** (vd. 2–3 gen qua custom pyramid), ma trận chỉ
có 2–3 hàng. Ô 256×256 chứa 2–3 hàng dữ liệu + 253–254 hàng padding. Nếu
dùng `vExtent = n_genes / 256` như ô biên thông thường, shader sẽ chỉ hiển
thị 2–3 hàng chiếm < 1% chiều cao ô → **gen quá nhỏ, không thấy được**.

Giải pháp: **không giảm vExtent**. Thay vào đó, backend **không coarsen trục
gen** khi ≤ 1 hàng, và frontend **giới hạn cấp** + **kéo giãn dataExtent =
[1, 1]** để 2–3 hàng dữ liệu **lấp đầy toàn bộ 256 pixel** của ô:

```
┌──── Ít gen (< 256): kéo giãn toàn trục Y ────┐
│                                               │
│  2 gen, ô 256×256:                            │
│                                               │
│  Zarr (2 hàng):      Texture (256px):          │
│  ┌──┬──┐             ┌──────────────┐          │
│  │G1│G2│   → vExtent │ G1 (128px)   │ ← kéo    │
│  └──┴──┘     = 1.0   │ G2 (128px)   │   giãn   │
│                       └──────────────┘          │
│  (2 hàng thật)         (256 pixel hiển thị)     │
│                                               │
│  Shader: uv.y * 1.0 → lấy toàn 256px          │
│  → 2 hàng dữ liệu lấp đầy 256 pixel            │
│  → Mỗi gen cao 128px (thay vì 1px)            │
│                                               │
│  Nhưng! Nhãn gen phải khớp vị trí kéo giãn:    │
│  Gen 0 ở y = 0.5 × (256/2) = 64               │
│  Gen 1 ở y = 1.5 × (256/2) = 192              │
│  (không phải 0.5 và 1.5!)                     │
└───────────────────────────────────────────────┘
```

**Ba thay đổi đồng bộ** để xử lý trường hợp này:

**1. Backend — Không coarsen trục gen khi ≤ 1:**

```python
# backend/build_pyramid.py — _coarsen_mean()
axes = {}
if h2 >= factor:
    axes[0] = factor      # Chỉ coarsen nếu đủ hàng
if w2 >= factor:
    axes[1] = factor
if not axes:
    return arr             # Quá nhỏ → giữ nguyên
return da.coarsen(np.nanmean, arr, axes, trim_excess=False)
```

```python
# backend/server.py — CustomPyramid._build_small()
if h <= 1:
    h2 = h                 # Giữ nguyên số hàng gen
    coarse = sub[:h2, :w2].copy()
    coarse = coarse.reshape(h2, 1, w2 // 2, 2)
    coarse = coarse.mean(axis=(1, 3))   # Chỉ coarsen trục X (cells)
```

**2. Frontend — Giới hạn cấp (level cap) theo số gen:**

```typescript
// client/src/HeatmapTileLayer.ts — computeVisibleTiles()
const nGenes = levels[0][0];
if (nGenes > 0 && nGenes < TILE) {
  // Mỗi cấp halve resolution → max cấp giữ ≥ 1 hàng = floor(log2(nGenes))
  // 2 gen → maxGeneLevel = 1 (cấp 2 sẽ gộp 2 gen → 1, mất gen)
  const maxGeneLevel = Math.floor(Math.log2(nGenes));
  level = Math.min(level, maxGeneLevel);
}
```

**3. Frontend — Căn nhãn trục theo vị trí kéo giãn:**

```typescript
// client/src/AxisLabels.ts — createAxisLayers()
// Khi n_genes < 256, shader kéo giãn n hàng lấp đầy 256px
// → Gen j nằm ở vị trí (j + 0.5) × (TILE / nGenes) trong world coords
const geneScale = nGenes > 0 && nGenes < TILE ? TILE / nGenes : 1;
for (let j = 0; j < varNames.length; j += geneStride) {
  const yPos = (j + 0.5) * geneScale;   // Khớp vị trí kéo giãn
  geneData.push({ position: [-2, yPos], text: varNames[j] });
}
```

```typescript
// client/src/HeatmapView.tsx — worldHeight + fit zoom
// Chiều cao world = max(n_genes, TILE) vì ô được kéo giãn
const worldHeight = rawGenes < TILE ? TILE : rawGenes;
// Mỗi gen cao (TILE / nGenes) world units → clamp zoom để không quá lớn
const visualGeneHeight = nGenes < TILE ? TILE / nGenes : 1;
const maxPxPerGene = 150;
const pxPerWorldUnit = maxPxPerGene / visualGeneHeight;
const minZoomForGenes = Math.log2(pxPerWorldUnit);
fitZoom = Math.max(fitZoom, minZoomForGenes);
```

> **Bài học:** Khi texture bị kéo giãn (dataExtent), **mọi thành phần phụ
> thuộc vị trí** (nhãn trục, viền, tooltip) đều phải tính theo hệ số kéo giãn
> tương tự, nếu không sẽ bị lệch.

### E. Chọn cấp kim tự tháp (Level Selection)

Ở mỗi mức zoom, trình duyệt chọn **một cấp** kim tự tháp để hiển thị. Công
thức:

```
level = floor(-zoom),  giới hạn [0, maxLevel]

  Zoom = 0   → level 0  (chi tiết nhất, 1 cell = 1px)
  Zoom = -2  → level 2  (mỗi cell = 0.25px, cần ô thô hơn)
  Zoom = -8  → level 8  (xem toàn bộ, ô thô nhất)
  Zoom = +1  → level 0  (zoom vào, vẫn cấp 0 — không có cấp -1)
```

**Vì sao `floor` chứ không `round`?** Làm tròn xuống thiên về **cấp chi tiết
hơn**. Ô hơi quá chi tiết sẽ bị GPU nearest-filter **thu nhỏ** (vẫn sắc nét);
ô quá thô sẽ bị **phóng to** (mờ, blurry). Floor đảm bảo luôn sắc nét.

**Giới hạn bổ sung (gene level cap):** Khi ít gen (< 256), cấp bị giới hạn
thêm bởi `floor(log2(nGenes))` để không gộp gen thành 0 hàng (xem mục D).

```
┌──────── Chọn cấp theo zoom ────────┐
│                                      │
│  Zoom    level    Mỗi cell =         │
│  ──────────────────────────────      │
│  +2      0       4px    (rõ)         │
│   0      0       1px    (fit)        │
│  -2      2       0.25px (thô)        │
│  -4      4       1/16px  (thô hơn)   │
│  -8      8       1/256px (thô nhất)  │
│                                      │
│  level = floor(-zoom)                │
│  → Mỗi ô cấp L = 256 × 2^L world units│
└──────────────────────────────────────┘
```

### F. Ánh xạ world → ô (World-to-Tile Mapping)

Hệ tọa độ world: ma trận chiếm `[0, n_cells] × [0, n_genes]` (X = tế bào
phải, Y = gen xuống). Ở viewport zoom `z`, 1 world unit = `2^z` pixel.

```
┌──── Ánh xạ world → ô (cấp L) ────┐
│                                    │
│  Trục Y (gen, tuyến tính):         │
│  Ô hàng r: world [r·256·2^L,       │
│                     (r+1)·256·2^L)│
│  → r0 = floor(north / tileWorldH)  │
│  → r1 = floor(south / tileWorldH)  │
│                                    │
│  Trục X (tế bào, có khe cụm):      │
│  Không tuyến tính khi có gap →     │
│  binary search qua groupWorldStarts│
│  → _findFirstTileColInViewport()   │
│  → _findLastTileColInViewport()    │
│                                    │
│  Mỗi ô:                            │
│  bounds = [x0,y1],[x0,y0],         │
│          [x1,y0],[x1,y1]           │
│  dataExtent = [uExtent, vExtent]  │
│  → Truyền cho shader               │
└────────────────────────────────────┘
```

```typescript
// client/src/HeatmapTileLayer.ts — computeVisibleTiles()
const downsample = Math.pow(2, level);
const tileWorldW = TILE * downsample;   // Ô cấp L rộng 256·2^L world units
const tileWorldH = TILE * downsample;

// Y: tuyến tính → floor trực tiếp
const r0 = Math.max(0, Math.floor((north - marginY) / tileWorldH));
const r1 = Math.min(nRows - 1, Math.floor((south + marginY) / tileWorldH));

// X: có khe → binary search
if (!hasGapLayout) {
  c0 = Math.max(0, Math.floor((west - marginX) / tileWorldW));
  c1 = Math.min(nCols - 1, Math.floor((east + marginX) / tileWorldW));
} else {
  c0 = _findFirstTileColInViewport(layout, west - marginX, ...);
  c1 = _findLastTileColInViewport(layout, east + marginX, ...);
}
```

### F-bis. Hai không gian tọa độ trong computeVisibleTiles()

Một câu hỏi quan trọng: **các thông số trong `computeVisibleTiles()` được tính
trên ma trận level nào?** Câu trả lời: **không hoàn toàn level 0** — hàm dùng
**hai không gian tọa độ khác nhau**:

```
┌──── Hai không gian trong computeVisibleTiles() ────┐
│                                                      │
│  Không gian 1: World coords — Level 0                │
│  ─────────────────────────────────────                │
│  • west, east, north, south (viewport bounds)        │
│  • target[0], target[1] (view center)               │
│  • tileWorldW, tileWorldH = 256 × 2^level            │
│  → Tất cả tính bằng world units level 0              │
│    (1 cell = 1 world unit, không đổi dù đổi level)  │
│                                                      │
│  Không gian 2: Lưới ô — Level đã chọn                │
│  ─────────────────────────────────────                │
│  • [h, w] = levels[level]  (shape level đã chọn)     │
│  • nRows = ceil(h / 256), nCols = ceil(w / 256)      │
│  • dataExtent = (h - r×256)/256, (w - c×256)/256     │
│  → Số ô và tỉ lệ dữ liệu tính trên level đã chọn     │
│                                                      │
│  Cầu nối: tileWorldW = 256 × 2^level                 │
│  → Chuyển 256px (level đã chọn) sang world (level 0) │
│  → floor(world / tileWorldW) = ô index               │
│                                                      │
└──────────────────────────────────────────────────────┘
```

**Vì sao tách hai không gian?** Khi pan/zoom, **tọa độ world không đổi** dù
đổi level — chỉ độ phân giải ô thay đổi. Nếu tính viewport bounds trên level
đã chọn, pan ở level 9 rồi zoom vào level 0 sẽ "nhảy" vị trí vì world scale
khác nhau giữa các level.

```typescript
// client/src/HeatmapTileLayer.ts — computeVisibleTiles()

// ── Không gian 1: World (Level 0) ──
const visW = width / Math.pow(2, zoom);    // world units (level 0)
const west = target[0] - visW / 2;          // world bounds — level 0
const east = target[0] + visW / 2;

// ── Không gian 2: Lưới ô (Level đã chọn) ──
const [h, w] = levels[level];               // shape LEVEL ĐÃ CHỌN
const nRows = Math.ceil(h / TILE);           // số ô — level đã chọn
const nCols = Math.ceil(w / TILE);

// ── Cầu nối ──
const downsample = Math.pow(2, level);
const tileWorldW = TILE * downsample;        // 256px → world (level 0)

// World (level 0) → ô index (level đã chọn):
const c0 = Math.floor(west / tileWorldW);    // floor(world / 256·2^L)
const c1 = Math.floor(east / tileWorldW);

// dataExtent (level đã chọn):
const uExtent = Math.min(1, (w - c * TILE) / TILE);  // w = levels[level][1]
const vExtent = Math.min(1, (h - r * TILE) / TILE);  // h = levels[level][0]
```

**Ví dụ cụ thể — GSE145926** (từ `data/heatmap.zarr/meta.json`):

```
Level 0: [33538, 108230]  → 33538 gen × 108230 tế bào
Level 2: [8384,  27057]   → 8384 gen  × 27057 tế bào
Level 9: [65,    211]     → 65 gen    × 211 tế bào

Khi zoom = -2 → level = 2:

  Không gian 1 (World, level 0):
    west=0, east=108230 (world units)

  Không gian 2 (Lưới ô, level 2):
    h=8384, w=27057 (shape level 2)
    nRows = ceil(8384/256) = 33 ô hàng
    nCols = ceil(27057/256) = 106 ô cột

  Cầu nối:
    tileWorldW = 256 × 2² = 1024 world units/ô
    c0 = floor(0 / 1024) = 0
    c1 = floor(108230 / 1024) = 105

  dataExtent (ô cuối, level 2):
    uExtent = (27057 - 105×256) / 256
            = (27057 - 26880) / 256 = 177/256 = 0.69
    → 69% texture có dữ liệu, 31% padding
```

**Ngoại lệ duy nhất dùng Level 0 trực tiếp** — giới hạn cấp cho custom
pyramid ít gen:

```typescript
// client/src/HeatmapTileLayer.ts:95-99
const nGenes = levels[0][0];               // tổng số gen THẬT (level 0)
if (nGenes > 0 && nGenes < TILE) {
  const maxGeneLevel = Math.floor(Math.log2(nGenes));
  level = Math.min(level, maxGeneLevel);   // cap để không gộp gen thành 0
}
```

Lý do dùng level 0: cần biết **tổng số gen thật** (không bị coarsen) để tính
cấp tối đa giữ ≥ 1 hàng gen. Nếu dùng `levels[level][0]`, ở cấp cao gen đã
bị gộp → số nhỏ hơn → cap sai.

```
┌──── Tóm tắt: level nào cho đại lượng nào? ────┐
│                                                 │
│  Đại lượng                  Level               │
│  ─────────────────────────────────────          │
│  west/east/north/south     Level 0 (world)     │
│  target (view center)      Level 0 (world)     │
│  tileWorldW/H              Level 0 (world)     │
│  [h, w] = levels[level]    Level đã chọn       │
│  nRows, nCols              Level đã chọn       │
│  dataExtent                Level đã chọn       │
│  nGenes (gene cap)         Level 0 (thật)      │
│                                                 │
│  → Tọa độ = level 0 (ổn định khi pan/zoom)      │
│  → Lưới ô = level đã chọn (đổi theo zoom)       │
│  → tileWorldW = 256×2^L (cầu nối)              │
└─────────────────────────────────────────────────┘
```

### G. Hiển thị trên GPU — Pipeline đầy đủ

Từ byte grayscale đến pixel màu trên màn hình, shader thực hiện **4 bước**:

```
┌─────── Pipeline shader (GPU) ───────┐
│                                       │
│  Bước 1: Lấy UV + remap dataExtent    │
│  uv = vTexCoord * dataExtent          │
│  → Chỉ sample phần dữ liệu, bỏ padding│
│                                       │
│  Bước 2: Đọc byte grayscale           │
│  grayByte = texture(bitmap, uv).r    │
│             * 255.0                   │
│  → 0–255 (sampler trả 0.0–1.0)       │
│                                       │
│  Bước 3: Discard null                 │
│  if (grayByte <= 0.5) discard;       │
│  → Byte 0 (padding) → trong suốt     │
│                                       │
│  Bước 4: Tra LUT                      │
│  lutT = (grayByte - 1) / 254          │
│  → Byte 1–255 → LUT 0–1              │
│  color = texture(colorMapLUT, lutT)   │
│  → Màu từ palette (Viridis/Magma/...) │
│                                       │
│  Kết quả: fragColor = color           │
└───────────────────────────────────────┘
```

```glsl
// client/src/GroupedHeatmapLayer.ts — fragment shader (đầy đủ)
void main(void) {
  vec2 uv = vTexCoord;
  // ... coordinate conversion (mercator/lnglat) nếu cần ...

  // 1. Remap UV theo dataExtent (kéo giãn phần dữ liệu)
  uv = uv * heatmap.dataExtent;

  // 2. Đọc byte grayscale
  float grayByte = texture(bitmapTexture, uv).r * 255.0;

  // 3. Discard null (byte 0 = padding)
  if (grayByte <= 0.5) { discard; }

  // 4. Byte 1-255 → LUT 0-1 → màu
  float lutT = clamp((grayByte - 1.0) / 254.0, 0.0, 1.0);
  vec4 color = texture(colorMapLUT, vec2(lutT, 0.5));
  fragColor = vec4(color.rgb, color.a * layer.opacity);
}
```

**Vì sao nearest filtering?** Mỗi pixel texture = 1 cell-gene. Linear
filtering sẽ **trộn hàng xóm** → mờ, mất ranh giới cụm. Nearest giữ mỗi cell
là **một ô vuông sắc nét**.

```typescript
// client/src/HeatmapTileLayer.ts — createTileLayers()
textureParameters: {
  minFilter: "nearest",
  magFilter: "nearest",
}
```

### G-bis. World → Screen: Cách ô "nhét" vào màn hình

Một câu hỏi quan trọng: **bounds của ô có thể lên tới 108.230 (hoặc 20 triệu)
world units, lớn hơn nhiều so với màn hình 800px — làm sao ô "nhét" vừa?**

Câu trả lời: **deck.gl OrthographicView** có tham số **`zoom`** — hệ số tỉ lệ
giữa world units và pixel màn hình.

#### Công thức chiếu (Projection)

```
screen_x = (world_x - target_x) × 2^zoom + screen_center_x
```

**`zoom` = logarit của hệ số tỉ lệ:** `1 world unit = 2^zoom pixel`

| zoom | 1 world unit = | Ý nghĩa |
|------|----------------|---------|
| +2   | 4 pixel        | Zoom vào 4× |
| 0    | 1 pixel         | Chi tiết đầy đủ (1:1) |
| -4   | 0.0625 pixel   | Thu nhỏ 16× |
| -7   | 0.0078 pixel   | Thu nhỏ 128× (xem toàn bộ) |

#### Fit zoom — Nhét toàn bộ ma trận vào khung nhìn

Khi load lần đầu, [`HeatmapView.tsx`](../client/src/HeatmapView.tsx) tính
**fit zoom** để toàn bộ ma trận vừa khung:

```typescript
// client/src/HeatmapView.tsx — fit zoom
let fitZoom = Math.log2(
  Math.min(size.width / worldWidth, size.height / fitWorldH)
);
```

**Ví dụ GSE145926** (108.230 cells × 33.538 genes, màn hình 800×600):

```
worldWidth  = 108.230 (world units)
worldHeight = 33.538  (world units)

fitZoom = log2(min(800 / 108230, 600 / 33538))
        = log2(min(0.00739, 0.01788))
        = log2(0.00739)
        = -7.08

→ 1 world unit = 2^(-7.08) = 0.00739 pixel
→ 108.230 world units × 0.00739 = 800 pixel  ✓ (vừa khung ngang)
→ 33.538  world units × 0.00739 = 248 pixel  ✓ (vừa khung dọc)
```

#### Tile bounds → pixel màn hình

Mỗi ô có bounds bằng world units. Deck.gl chiếu 4 góc bounds ra pixel:

```
┌──── Chiếu world → screen (zoom = -7.08) ────┐
│                                                │
│  Ô level 9 (toàn bộ ma trận):                  │
│  World bounds: [0,0] → [108230, 65536]        │
│  Screen (× 0.00739): [0,0] → [800, 484] px    │
│  → Vừa khít trong khung 800×600               │
│                                                │
│  Ô level 0, cột 0 (256 tế bào đầu):           │
│  World bounds: [0,0] → [256, 256]             │
│  Screen (× 0.00739): [0,0] → [1.89, 1.89] px  │
│  → Nhỏ hơn 2 pixel! (không thấy)              │
│  → Deck.gl tự loại bỏ (culling)               │
│                                                │
└────────────────────────────────────────────────┘
```

#### BitmapLayer — Kéo giãn texture 256px vào screen bounds

Khi một ô được hiển thị, deck.gl `BitmapLayer` lấy texture PNG 256×256px và
**kéo giãn** nó vào 4 góc bounds (đã chiếu ra pixel):

```
┌──── BitmapLayer: texture → screen ────┐
│                                         │
│  Texture 256×256px    Bounds (screen)  │
│  ┌──────────┐         ┌──────────┐     │
│  │          │  →      │          │     │
│  │  PNG     │  kéo   │  Pixel   │     │
│  │  256px   │  giãn  │  màu     │     │
│  │          │         │          │     │
│  └──────────┘         └──────────┘     │
│                        ← screen size  │
│                           (do zoom)    │
└─────────────────────────────────────────┘
```

- Ở zoom -7: texture 256px → ~2px (xem toàn bộ, thu nhỏ)
- Ở zoom 0: texture 256px → 256px (chi tiết đầy đủ, 1:1)
- Ở zoom +2: texture 256px → 1024px (zoom vào, phóng to 4×)

#### Tóm tắt: 3 lớp biến đổi

```
┌──── 3 lớp: số → texture → pixel ────┐
│                                       │
│  Lớp 1: Zarr → PNG (backend)         │
│    float value → byte 1-255           │
│    → Cố định 256×256 pixel            │
│                                       │
│  Lớp 2: World → Screen (deck.gl)     │
│    world × 2^zoom = pixel            │
│    → 108.230 × 0.00739 = 800px      │
│    → 256 × 0.00739 = 1.89px         │
│                                       │
│  Lớp 3: Texture → Screen (Bitmap)    │
│    256px texture kéo giãn vào bounds  │
│    → Thu nhỏ / 1:1 / phóng to        │
│    → GPU nearest filtering: sắc nét   │
│                                       │
└───────────────────────────────────────┘
```

> **Tóm lại:** World bounds có thể lớn tùy ý (108.230, 20 triệu...) —
> **`zoom`** là hệ số tỉ lệ thu/phóng. Deck.gl tự động chiếu world → pixel,
> và `BitmapLayer` kéo giãn texture 256px vào khoảng pixel đó. Khi zoom xa
> (`zoom = -7`), 108.230 world units chỉ chiếm 800 pixel; khi zoom vào
> (`zoom = 0`), 256 world units chiếm 256 pixel — cùng một cơ chế, chỉ khác
> hệ số.

### H. Tổng kết — Hành trình 1 ô

```
Zarr (float32)
  │
  │  server.py: _store.tile(level, row, col)
  │  → Đọc khối 256×256 từ zarr (có thể < 256 ở biên)
  │
  ▼
tile_render.py: render_tile_png(values, vmin, vmax)
  │  → Mã hóa: float → byte 1-255 (dữ liệu), NaN → byte 0 (null)
  │  → Đệm NaN thành 256×256 nếu thiếu
  │  → PIL Image mode="L" → PNG bytes
  │
  ▼
HTTP: POST /api/tile (body: level,row,col) → PNG 256×256 grayscale
  │  → disk cache (LRU 20GB, TTL 24h)
  │
  ▼
Trình duyệt: computeVisibleTiles()
  │  → Chọn cấp = floor(-zoom) (cap theo nGenes)
  │  → Index-based culling (binary search)
  │  → Tính bounds + dataExtent cho mỗi ô
  │
  ▼
GroupedHeatmapLayer (deck.gl)
  │  → BitmapLayer tải PNG làm texture
  │  → Shader: uv *= dataExtent → bỏ padding
  │  → Shader: byte 0 → discard
  │  → Shader: byte 1-255 → LUT → màu
  │  → Nearest filtering = sắc nét
  │
  ▼
Pixel màu trên màn hình (60 FPS)
```

---

## Sơ đồ tổng thể kiến trúc

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                   KIẾN TRÚC TOÀN DIỆN (v0.2 — 20M cells)                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ╔══════════════════════ BACKEND (Python) ═════════════════════════╗        │
│  ║                                                                 ║        │
│  ║  File .h5ad (sinh học, sparse ~250 GB)                         ║        │
│  ║       │                                                         ║        │
│  ║       ▼                                                         ║        │
│  ║  build_pyramid.py (out-of-core streaming)                      ║        │
│  ║   < 2M cells: _build_small() (in-memory)                       ║        │
│  ║   ≥ 2M cells:                                                  ║        │
│  ║   1. _streaming_transpose(): chunk 50K cells → gene-major zarr ║        │
│  ║   2. _cluster_order(): sắp xếp theo cụm (stable sort)          ║        │
│  ║   3. _reorder_cells(): zarr oindex fancy indexing (256×256)    ║        │
│  ║   4. _build_pyramid_levels(): dask from_zarr → 2×2 mean-pool   ║        │
│  ║   5. _streaming_percentile(): random sample 10M → p1/p99     ║        │
│  ║   6. _write_metadata(): cell_order as zarr array (NOT json)  ║        │
│  ║       │                                                         ║        │
│  ║       ▼                                                         ║        │
│  ║  data/ (nhiều zarr — đa heatmap)                               ║        │
│  ║   ├── heatmap.zarr/ (default)                                  ║        │
│  ║   │   ├── level_0/ ... level_N/ (dask out-of-core pyramid)     ║        │
│  ║   │   ├── cell_order/ (int32 zarr — hoán vị tế bào)            ║        │
│  ║   │   ├── cell_ids/, louvain/, umap/ (sau reorder)             ║        │
│  ║   │   └── meta.json (kích thước, cấp, vmin/vmax, cụm)          ║        │
│  ║   ├── GSE145926.zarr/ ...                                      ║        │
│  ║   └── RP-01KXQQVM0C7A5ZKNDBZKSDRXEY.zarr/ ...                 ║        │
│  ║       │                                                         ║        │
│  ║       ▼                                                         ║        │
│  ║  generate_pyramid.py (legacy, chỉ dataset nhỏ)                ║        │
│  ║   → data/tiles/default/ (PNG tĩnh — fallback)                  ║        │
│  ║       │                                                         ║        │
│  ║       ▼                                                         ║        │
│  ║  server.py (FastAPI async :8001)                               ║        │
│  ║   ├── PyramidRegistry (LRU + TTL + shutdown cleanup)          ║        │
│  ║   │   └── registry.get(dataset_id) → đúng zarr store           ║        │
│  ║   ├── POST /api/datasets → liệt kê heatmap có sẵn             ║        │
│  ║   ├── POST /api/tile (body: dataset_id?, level, row, col)     ║        │
│  ║   │   └── asyncio.to_thread → tile_cache.get_or_render()      ║        │
│  ║   ├── POST /api/obs/range → lazy metadata (body: start, end)  ║        │
│  ║   ├── POST /api/obs → 413 nếu ≥ 1M cells                     ║        │
│  ║   ├── POST /api/cell_order, /api/cache/stats                 ║        │
│  ║   ├── POST /api/custom → out-of-core gene subset pyramid      ║        │
│  ║   └── GET /tiles/...png → static (legacy)                     ║        │
│  ╚═════════════════════════════════════════════════════════════════╝        │
│                                    │ HTTP                                   │
│                                    ▼                                        │
│  ╔══════════════════════ FRONTEND (TypeScript) ═════════════════════╗      │
│  ║                                                                 ║      │
│  ║  Vite Dev Server (:5173) — proxy /api → :8001                  ║      │
│  ║       │                                                         ║      │
│  ║       ▼                                                         ║      │
│  ║  HeatmapView.tsx (React)                                        ║      │
│  ║   0. fetchDatasets() → dropdown chọn heatmap                   ║      │
│  ║   1. fetchMeta() → kích thước, cấp, cụm                        ║      │
│  ║   2. setUseDynamicTiles(true) → /api/tile (mặc định)          ║      │
│  ║   3. needsRTC = n_cells ≥ 1M → originX = width/2              ║      │
│  ║   4. SpatialLayout(groups, gap, originX) → RTC coords         ║      │
│  ║   5. computeVisibleTiles() → index-based culling (binary)     ║      │
│  ║   6. fetchObsRange(start, end) → lazy metadata (< 5K cells)  ║      │
│  ║   7. TileLoader.getSync() → POST /api/tile → blob URL (LRU)   ║      │
│  ║   8. createTileLayers() → GroupedHeatmapLayer mỗi ô           ║      │
│  ║   9. createGapOverlayLayers() → che khe                       ║      │
│  ║  10. createTileBorderLayer() → viền + hover                    ║      │
│  ║  11. createClusterAnnotationLayers() → tên cụm               ║      │
│  ║  12. createAxisLayers() → nhãn trục                            ║      │
│  ║       │                                                         ║      │
│  ║       ▼                                                         ║      │
│  ║  deck.gl (WebGL2)                                               ║      │
│  ║   ├── OrthographicView (pan/zoom 2D, coordinateOrigin=originX)║      │
│  ║   ├── GroupedHeatmapLayer (BitmapLayer + custom shader)        ║      │
│  ║   │   └── Shader: grayscale byte → LUT color                   ║      │
│  ║   │       ├── byte 0 → discard (null)                          ║      │
│  ║   │       ├── byte 1-255 → LUT 0-1 → color                      ║      │
│  ║   │       └── dataExtent → remap UV (ô biên)                   ║      │
│  ║   ├── LUT Texture (256×1, đổi palette = đổi texture)          ║      │
│  ║   └── 60 FPS rendering                                          ║      │
│  ║                                                                 ║      │
│  ╚═════════════════════════════════════════════════════════════════╝      │
│                                    │                                        │
│                                    ▼                                        │
│                          🔥 HEATMAP HIỂN THỊ                                │
│              (20M cells, tương tác, zoom, hover, đổi màu, 60 FPS)           │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Tóm tắt: Tại sao kiến trúc này?

| Quy tắc | Ý tưởng | Lợi ích |
|---|---|---|
| **Dynamic tile + disk cache** | Render on-the-fly, cache LRU trên SSD | Không 6,2M file tĩnh, build nhanh, cache tự dọn |
| **Out-of-core streaming** | Chunk 50K cells, dask from_zarr | RAM < 8 GB dù 400 tỷ giá trị |
| **Streaming percentile** | Random sample 10M từ level_0 | vmin/vmax không cần load 1,6 TB |
| **cell_order as Zarr** | Hoán vị lưu mảng Zarr, không JSON | meta.json không phình to (160 MB → 80 MB nén) |
| Grayscale + GPU LUT | Ảnh đen trắng, tô màu trên GPU | Đổi palette 0ms, tiết kiệm băng thông |
| Kim tự tháp đa cấp | Nhiều độ phân giải (dask out-of-core) | Tải đúng chi tiết cho zoom hiện tại |
| Sắp xếp theo cụm | Nhóm tế bào cùng loại (zarr fancy indexing) | Thấy cấu trúc sinh học |
| Khe cụm (SpatialLayout) | Tách 2 mảng raw/world + RTC originX | Ô đúng vị trí, không jitter Float32 |
| **Index-based culling** | Binary search thay vì quét toàn bộ | O(log n) thay vì O(nRows×nCols) |
| **Lazy metadata fetch** | /api/obs/range chỉ vùng xem | Browser không OOM với 20M tế bào |
| **Out-of-core custom** | Stream gene rows → per-custom zarr | Chọn 20K gen không nổ RAM |
| dataExtent UV remap | Chỉ lấy phần dữ liệu ô biên | Không còn dải đen padding |
| **POST + TileLoader** | Tất cả API dùng POST, blob URL cache LRU | Đồng nhất method, cache tự quản, không browser cache |
| **PyramidRegistry** | Đa heatmap, LRU + TTL + shutdown cleanup | Nhiều analysis, không nổ RAM/file handles |

> **Kết luận:** Kiến trúc v0.3 biến một bảng số **400 tỷ ô** (20M tế bào × 20K gen) thành heatmap tương tác 60 FPS, bằng cách: out-of-core streaming giữ RAM < 8 GB, dynamic tile + disk cache thay 6,2M file tĩnh, RTC giải Float32 jitter, index-based culling thay quét toàn bộ, lazy metadata fetch tránh browser OOM, POST + TileLoader cho cache tự quản, và PyramidRegistry hỗ trợ đa heatmap.

---

## ❓ Câu hỏi thường gặp (Q&A)

### Q1: Ô 256×256 nghĩa là 256 gen × 256 tế bào? Vì sao chọn 256?

**Đúng** — vì ma trận đã bị xoay thành (n_genes, n_cells), một ô 256×256 chứa:

```
┌─────────────────────────────┐
│ Gen 0   ░░▓▓████▓▓░░       │ 256 hàng (gene)
│ Gen 1   ▓▓██████▓▓▓▓       │
│  ⋮         ⋮                │
│ Gen 255 ████▓▓░░▓▓██       │
└─────────────────────────────┘
        256 cột (cell)
```

**5 lý do chọn 256:**

| Lý do | Giải thích |
|---|---|
| **Lũy thừa của 2** | GPU xử lý texture hiệu quả nhất khi kích thước là 2^n. WebGL yêu cầu cho mipmapping. |
| **File nhỏ** | 256×256 = 65.536 pixel × 1 byte = 64 KB chưa nén → ~10-30 KB sau nén PNG |
| **Số ô hợp lý** | Cấp 0: 197×11 = 2.167 ô — không quá nhiều HTTP request, không quá ít |
| **Tiêu chuẩn công nghiệp** | Google Maps, Mapbox, OpenStreetMap, deck.gl — tất cả dùng 256×256 |
| **An toàn GPU** | Giới hạn texture GPU điển hình: 4096×4096. 256 nằm xa dưới → an toàn mọi thiết bị |

So sánh các kích thước:

```
┌────────────┬──────────────────┬───────────────────────────────┐
│ Kích thước │ Số ô ở cấp 0     │ Đánh giá                      │
├────────────┼──────────────────┼───────────────────────────────┤
│ 64×64      │ 788×42 = 33.096  │ Quá nhiều ô → quá nhiều request│
│ 128×128    │ 394×21 = 8.274   │ Vẫn khá nhiều                  │
│ 256×256    │ 197×11 = 2.167   ✓ Điểm ngọt (sweet spot)         │
│ 512×512    │ 99×6 = 594       │ Ít ô nhưng mỗi ô nặng, chậm   │
└────────────┴──────────────────┴───────────────────────────────┘
```

Cấu hình trong code (có thể đổi qua biến môi trường):
```python
# backend/config.py
TILE_SIZE = int(os.environ.get("HEATMAP_TILE_SIZE", "256"))
```

---

### Q2: Ở mọi level, ô PNG đều là 256×256 phải không?

**Đúng** — mọi file PNG trên đĩa LUÔN là 256×256 pixel, ở mọi cấp. Đây là nguyên tắc cố định.

```
Cấp 0:  2167 ô × 256×256 = 2167 file PNG (256×256)
Cấp 1:   594 ô × 256×256 =  594 file PNG (256×256)
  ⋮
Cấp 8:     1 ô × 256×256 =    1 file PNG (256×256)
```

**Ô biên (edge tiles)** — ô cuối mỗi hàng/cột có thể không đủ 256 pixel dữ liệu. Phần thiếu được đệm bằng byte 0 (null):

```
Cấp 2: 659 tế bào, mỗi ô 256 pixel cột
→ Cột 0: pixel 0-255   (đầy đủ 256)     ✓
→ Cột 1: pixel 256-511 (đầy đủ 256)     ✓
→ Cột 2: pixel 512-658 (CHỈ 147 pixel dữ liệu)
         + 109 pixel padding (byte 0 = null)

┌──────────────────────────────────────┐
│  Ô 0_2.png (256×256 pixel):          │
│  ┌──────────────┬───────────────────┐│
│  │  147 pixel   │  109 pixel        ││
│  │  dữ liệu thật │  padding = 0     ││
│  │  (byte 1-255) │  (byte 0 = null) ││
│  └──────────────┴───────────────────┘│
│  → Shader: byte 0 → discard (bỏ qua)│
│  → dataExtent remap: chỉ lấy 147px  │
└──────────────────────────────────────┘
```

Được thực hiện trong [`backend/generate_pyramid.py`](backend/generate_pyramid.py:90):

```python
if block.shape != (tile_size, tile_size):
    padded = np.full((tile_size, tile_size), np.nan)
    padded[: r1 - r0, : c1 - c0] = block  # Đặt dữ liệu vào góc trên-trái
    block = padded
```

---

### Q3: Tại sao kích thước ma trận (shape) ở level sau = 1/2 level trước?

Cần phân biệt **kích thước ma trận (shape)** vs **kích thước khối Zarr (chunk)**.

#### Shape — ĐÚNG bị halved mỗi cấp

```
Cấp 0: 50402 × 2638   ← Ma trận đầy đủ
Cấp 1: 25201 × 1319   ← ≈ 1/2 cấp 0
Cấp 2: 12600 × 659    ← ≈ 1/2 cấp 1
  ⋮
Cấp 8: 196 × 10       ← ≈ 1/2 cấp 7
```

**Vì sao?** Mỗi cấp gộp 2×2 ô của cấp trước thành 1 ô bằng giá trị trung bình (mean pooling):

```
Cấp trước (4 ô):           Cấp sau (1 ô):
┌─────┬─────┐
│ 2.0 │ 4.0 │             ┌──────────┐
├─────┼─────┤    ──→       │ (2+4+6+8)│ = 5.0
│ 6.0 │ 8.0 │             │    /4    │
└─────┴─────┘             └──────────┘
 2 hàng × 2 cột            1 hàng × 1 cột
→ Mỗi chiều giảm đi một nửa
```

**Mục đích:** Tạo phiên bản thô hơn. Khi zoom ra, trình duyệt tải cấp thô (ít pixel) thay vì cấp chi tiết (nhiều pixel) → nhanh hơn.

**Vì sao factor=2 chứ không 4 hay 8?** Factor=2 cho số cấp tối ưu: đủ nhiều cấp để có lựa chọn độ phân giải phù hợp mỗi mức zoom, nhưng không quá nhiều (tốn dung lượng). Factor=2 là tiêu chuẩn trong kim tự tháp ảnh (giống mipmapping trong game/đồ họa).

#### Chunk size Zarr — Đã sửa (trước đây bị halved mỗi cấp)

**Trước khi sửa** — chunk size bị halved mỗi cấp do bug:

```
Cấp 0: chunks = [256, 256]   ✓ ĐÚNG
Cấp 1: chunks = [128, 128]   ✗ SAI — bị halved
Cấp 2: chunks = [64, 64]     ✗ SAI
Cấp 3: chunks = [32, 32]     ✗ SAI
Cấp 4: chunks = [16, 16]     ✗ SAI
```

**Nguyên nhân:** Trong [`build_pyramid.py`](backend/build_pyramid.py:155), `current.to_zarr()` ghi dask array vào zarr. Dask array sau `_coarsen_mean(2)` có chunk size bị halved (vì dữ liệu halved nhưng số chunk giữ nguyên). `to_zarr` dùng chunk size của dask, bỏ qua `chunks` đã set ở dòng 146.

**Sau khi sửa** — thêm `current.rechunk(chunks)` trước khi ghi:

```
Cấp 0: chunks = [256, 256]   ✓
Cấp 1: chunks = [256, 256]   ✓
Cấp 2: chunks = [256, 256]   ✓
Cấp 3: chunks = [256, 256]   ✓
Cấp 4: chunks = [256, 164]   ✓ (164 < 256 → min(256, 164))
```

Mọi cấp giờ có chunk 256×256 (hoặc nhỏ hơn nếu ma trận < 256), nhất quán với cách `generate_pyramid.py` đọc.

**Lưu ý:** Bug này KHÔNG ảnh hưởng output PNG! Vì `generate_pyramid.py` đọc theo **tọa độ** (arr[r0:r1, c0:c1]), không theo chunk size:

```
┌──────────────────────────────────────────────────────────┐
│                                                          │
│  Zarr (chunk 64×64)                                       │
│  level_2: 12600×659                                      │
│       │                                                  │
│       ▼  arr[0:256, 0:256] — Zarr tự ghép 16 chunk (4×4) │
│  Ma trận con 256×256 (trong RAM)                          │
│       │                                                  │
│       ▼  render_tile_png()                                │
│  File PNG 256×256 pixel (LUÔN đúng)                      │
│                                                          │
│  → generate_pyramid.py dùng TỌA ĐỘ để cắt,               │
│    KHÔNG dùng chunk size của Zarr                        │
│  → Zarr tự động ghép các chunk nhỏ thành ma trận con      │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

Trước khi sửa, bug chỉ ảnh hưởng **hiệu năng lưu trữ/đọc Zarr** (nhiều file nhỏ hơn cần thiết), không ảnh hưởng ảnh PNG đầu ra. Đã sửa bằng `current.rechunk(chunks)` trước khi ghi.

---

### Q4: Tại sao không gộp build_pyramid + generate_pyramid làm 1?

Về mặt kỹ thuật, hoàn toàn có thể gộp. Nhưng tách ra có **5 lý do**:

#### 1. Zarr dùng cho nhiều mục đích, không chỉ tạo PNG

```
build_pyramid.py → data/heatmap.zarr
                      ├── generate_pyramid.py → PNG tĩnh (legacy, dataset nhỏ)
                      ├── server.py (v0.2 — dynamic mặc định)
                      │     ├── POST /api/tile → dynamic + disk cache
                      │     ├── POST /api/obs/range → lazy metadata
                      │     ├── POST /api/value (hover tooltip)
                      │     └── POST /api/custom → out-of-core gene subset pyramid
                      └── debug / phân tích
```

Zarr là **nguồn sự thật** (source of truth), PNG chỉ là 1 trong nhiều sản phẩm từ nó. Gộp = mất khả năng truy vấn giá trị từng ô, tạo kim tự tháp tùy chỉnh.

#### 2. Tách "xây dữ liệu" (chậm, 1 lần) vs "tạo ảnh" (nhanh, làm lại được)

```
build_pyramid:    Đọc h5ad → sắp xếp → gộp → lưu Zarr
                 ⏱ Chậm (vài phút) — chỉ làm 1 LẦN
                 Phụ thuộc: file h5ad (có thể rất lớn)

generate_pyramid: Đọc Zarr → cắt PNG → lưu đĩa
                 ⏱ Nhanh (vài giây) — có thể LÀM LẠI
                 Phụ thuộc: Zarr (đã có sẵn)
```

Nếu sửa bug render, đổi tile size → chỉ chạy lại `generate_pyramid.py`, không cần đọc lại h5ad.

#### 3. Quản lý bộ nhớ (RAM)

```
build_pyramid:  Out-of-core streaming (v0.2) — RAM < 8 GB dù 20M cells
                < 2M cells: in-memory _build_small() (~500 MB)
generate_pyramid: Đọc từng ô 256×256 (64 KB/ô) → cực nhẹ
```

Gộp = giữ h5ad + dask + PNG cùng lúc = tốn RAM gấp đôi. Tách ra cho phép build_pyramid dùng out-of-core streaming riêng.

#### 4. Ranh giới kiến trúc rõ

```
build_pyramid  = xử lý dữ liệu sinh học (backend pipeline)
generate_pyramid = tạo tài sản tĩnh (asset generation)
server.py      = phục vụ tài sản (static file server)
```

#### 5. Linh hoạt khi phát triển

```
v0.1:  build_pyramid → generate_pyramid → server.py (/tiles tĩnh)
v0.2:  build_pyramid → server.py (/api/tile động + disk cache)  ← MẶC ĐỊNH
       (generate_pyramid chỉ legacy cho dataset nhỏ)
```

**Tóm lại:** Zarr là **cơ sở dữ liệu**, PNG (tĩnh hoặc dynamic cache) là **cache**. Tách database và cache là pattern chuẩn trong kỹ thuật phần mềm. Từ v0.2, dynamic tile + disk cache là mặc định — không cần generate_pyramid cho 20M tế bào.

---

### Q5: Hỗ trợ 20 triệu tế bào như thế nào?

Dự án v0.2 mở rộng từ 2.638 tế bào (dữ liệu thử nghiệm) lên **20 triệu tế bào** (20K gen × 20M cells = 400 tỷ giá trị). Đây là **9 thay đổi** chính:

| # | Thay đổi | Vấn đề giải quyết | Giải pháp |
|---|---|---|---|
| 1 | **Out-of-core streaming** | Dense 20M×20K = 1,6 TB RAM | Chunk 50K cells, streaming transpose → gene-major zarr |
| 2 | **Zarr fancy indexing** | Reorder 20M cells cần load toàn bộ | `oindex` gather 256×256 tiles, không materialize |
| 3 | **Dask out-of-core pyramid** | Pyramid coarsening cần RAM lớn | `da.from_zarr` lazy, 2×2 mean-pool từng cấp |
| 4 | **Streaming percentile** | vmin/vmax cần load 400 tỷ giá trị | Random sample 10M từ level_0 → p1/p99 (sai số <0,1%) |
| 5 | **cell_order as Zarr** | Hoán vị 20M cells = 160 MB JSON | Lưu mảng int32 zarr (80 MB nén), đọc từng phần |
| 6 | **Dynamic tile + disk cache** | 6,2M file PNG tĩnh → inode chết | Render on-the-fly, LRU cache 20 GB SSD, TTL 24h |
| 7 | **Index-based culling** | Quét 78K×200 = 15,6M ô mỗi frame | Binary search → O(log n), chỉ duyệt ô trong khung |
| 8 | **RTC coordinate** | Float32 jitter ở tọa độ > 16,7M | `coordinateOrigin` dịch về giữa, tọa độ < 16,7M |
| 9 | **Lazy metadata fetch** | 20M cell_ids = hàng trăm MB JSON | `/api/obs/range` chỉ trả vùng đang xem (< 5K cells) |

```
┌────────── Yêu cầu phần cứng cho 20M cells ──────────┐
│                                                      │
│  RAM:       8 GB (build), 4 GB (server), 4 GB (client)│
│  Đĩa:       ~250 GB (zarr) + 20 GB (cache SSD)       │
│  CPU:       8+ cores (dask parallel)                  │
│  Build time: ~2-4 giờ (streaming, 8 cores)            │
│  Network:   ~10 Mbps (dynamic tile, cache warm)      │
│                                                      │
│  → Chạy được trên workstation tiêu chuẩn (không cần HPC)│
└──────────────────────────────────────────────────────┘
```

Xem [`plans/20M_CELLS_FEASIBLE_PLAN.md`](../plans/20M_CELLS_FEASIBLE_PLAN.md) cho chi tiết kỹ thuật đầy đủ (9 phase, pseudocode, validation milestones).

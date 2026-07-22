# 🧬 Từ File h5ad đến Heatmap: Hướng dẫn toàn diện

> Tài liệu này giải thích **toàn bộ quy trình** — từ một file dữ liệu sinh học thô (`.h5ad`) cho đến một heatmap tương tác hiển thị trên trình duyệt — theo cách **ai cũng hiểu được**, kể cả người chưa biết lập trình.

---

## 📋 Mục lục

1. [Bối cảnh: Heatmap là gì và tại sao cần nó?](#1-bối-cảnh-heatmap-là-gì-và-tại-sao-cần-nó)
2. [Tổng quan quy trình (Big Picture)](#2-tổng-quan-quy-trình-big-picture)
3. [Bước 1: Đọc file h5ad — Dữ liệu thô](#bước-1-đọc-file-h5ad--dữ-liệu-thô)
4. [Bước 2: Sắp xếp lại theo cụm (Cluster Sorting)](#bước-2-sắp-xếp-lại-theo-cụm-cluster-sorting)
5. [Bước 3: Xây dựng kim tự tháp đa độ phân giải (Zarr Pyramid)](#bước-3-xây-dựng-kim-tự-tháp-đa-độ-phân-giải-zarr-pyramid)
6. [Bước 4: Cắt thành ảnh PNG tĩnh (Tile Generation)](#bước-4-cắt-thành-ảnh-png-tĩnh-tile-generation)
7. [Bước 5: Máy chủ phục vụ ảnh (FastAPI Server)](#bước-5-máy-chủ-phục-vụ-ảnh-fastapi-server)
8. [Bước 6: Trình duyệt tải và hiển thị (Frontend)](#bước-6-trình-duyệt-tải-và-hiển-thị-frontend)
9. [Bước 7: Tô màu trên GPU (Shader)](#bước-7-tô-màu-trên-gpu-shader)
10. [Bước 8: Tương tác người dùng (Zoom, Pan, Hover)](#bước-8-tương-tác-người-dùng-zoom-pan-hover)
11. [Sơ đồ tổng thể kiến trúc](#sơ-đồ-tổng-thể-kiến-trúc)
12. [Câu hỏi thường gặp (Q&A)](#-câu-hỏi-thường-gặp-qa)
    - [Q1: Ô 256×256 nghĩa là gì? Vì sao chọn 256?](#q1-ô-256x256-nghĩa-là-256-gen--256-tế-bào-vì-sao-chọn-256)
    - [Q2: Ở mọi level, ô PNG đều là 256×256?](#q2-ở-mọi-level-ô-png-đều-là-256x256-phải-không)
    - [Q3: Tại sao shape ở level sau = 1/2 level trước?](#q3-tại-sao-kích-thước-ma-trận-shape-ở-level-sau--12-level-trước)
    - [Q4: Tại sao không gộp build + generate?](#q4-tại-sao-không-gộp-build_pyramid--generate_pyramid-làm-1)

---

## 1. Bối cảnh: Heatmap là gì và tại sao cần nó?

### Vấn đề

Trong sinh học tế bào đơn (single-cell RNA-seq), nhà nghiên cứu đo lường **mức độ biểu hiện gen** của hàng nghìn đến hàng triệu tế bào. Kết quả là một **bảng số khổng lồ**:

- **Mỗi hàng** = một gen (ví dụ: 50.000 gen)
- **Mỗi cột** = một tế bào (ví dụ: 2.638 tế bào trong dữ liệu thử nghiệm, mục tiêu 4 triệu tế bào)
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

Hiển thị 133 triệu ô (mục tiêu: 80 tỷ ô) trên trình duyệt với **60 khung hình/giây** là bài toán cực khó:

| Thách thức | Giải pháp trong dự án này |
|---|---|
| Dữ liệu quá lớn cho RAM | Chia thành **ô nhỏ 256×256** (tiles) |
| Không thể tải tất cả cùng lúc | **Kim tự tháp đa độ phân giải** — tải đúng mức chi tiết cho mức zoom hiện tại |
| Tô màu tốn CPU | **GPU shader** tô màu tức thì |
| Chuyển bảng màu chậm | **Bảng tra cứu (LUT)** trên GPU — đổi màu trong 0ms |
| Vẽ lại khi zoom | **Tải động** chỉ những ô nhìn thấy |

---

## 2. Tổng quan quy trình (Big Picture)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         PIPELINE TỔNG QUAN                              │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  [File .h5ad]     [build_pyramid.py]      [generate_pyramid.py]          │
│  Dữ liệu thô  →  Sắp xếp + Kim tự tháp →  Cắt thành PNG tĩnh            │
│  (sinh học)       (Zarr)                 (256×256 grayscale)            │
│                        ↓                        ↓                        │
│                   data/heatmap.zarr      data/tiles/default/            │
│                   (ma trận đa tầng)      (ảnh PNG trên đĩa)              │
│                                                 ↓                       │
│                                    [server.py] FastAPI                  │
│                                    Phục vụ ảnh tĩnh                     │
│                                                 ↓  HTTP                 │
│                                    [Trình duyệt] Deck.gl                │
│                                    Tải ô + GPU tô màu                   │
│                                                 ↓                       │
│                                    🔥 HEATMAP HIỂN THỊ                  │
└─────────────────────────────────────────────────────────────────────────┘
```

Dưới đây là từng bước chi tiết.

---

## Bước 1: Đọc file h5ad — Dữ liệu thô

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

### Chi tiết kỹ thuật

```python
# backend/build_pyramid.py — hàm _load_matrix()
adata = read_h5ad(h5ad_path)          # Đọc toàn bộ file
mat = adata.layers["log_normalize"]  # Chọn lớp đã chuẩn hóa
mat = mat.toarray()                   # Chuyển sparse → dense
mat = mat.T                           # Xoay: (tế bào, gen) → (gen, tế bào)
```

**Quan trọng — Ma trận bị xoay (transpose):**
```
  Ban đầu (trong h5ad):          Sau khi xoay:
  (tế bào, gen)                  (gen, tế bào)
  2638 hàng × 50402 cột          50402 hàng × 2638 cột
  Hàng = tế bào                  Hàng = gen (trục Y)
  Cột = gen                      Cột = tế bào (trục X)
```

Lý do xoay: trong heatmap, **gen là hàng (Y)** và **tế bào là cột (X)**. Việc xoay ngay từ đầu giúp mọi bước sau nhất quán.

### Ưu điểm
- Đọc một lần, giữ trong RAM — nhanh cho các bước sau
- Chọn đúng lớp dữ liệu (đã chuẩn hóa) cho hiển thị

### Nhược điểm
- Toàn bộ ma trận phải vừa trong RAM (50402 × 2638 × 4 byte ≈ 500 MB — OK cho dữ liệu thử nghiệm, nhưng 4 triệu tế bào sẽ cần ~800 GB — cần chiến lược khác)
- Sparse → dense tốn bộ nhớ

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
mat = mat[:, order]                         # Áp dụng thứ tự mới vào ma trận
```

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

### Chi tiết kỹ thuật — Gộp 2×2 (mean pooling)

Mỗi cấp gộp 2×2 ô của cấp trước bằng **giá trị trung bình**:

```
Cấp 0 (4 ô):              Cấp 1 (1 ô):
┌─────┬─────┐            ┌──────────┐
│ 2.0 │ 4.0 │            │ (2+4+6+8)│
├─────┼─────┤   ──→      │    /4   │
│ 6.0 │ 8.0 │            │  = 5.0  │
└─────┴─────┘            └──────────┘
```

```python
# backend/build_pyramid.py — hàm _coarsen_mean()
def _coarsen_mean(arr, factor=2):
    return da.coarsen(np.nanmean, arr, {0: factor, 1: factor})
```

**Lưu ý quan trọng:** Chỉ gộp theo cả 2 chiều (gen và tế bào). Mỗi cấp giảm đi một nửa cả chiều ngang lẫn dọc.

### Lưu trữ Zarr

Zarr là định dạng lưu ma trận **chia thành khối (chunks)** trên đĩa — mỗi khối 256×256, nén riêng:

```
data/heatmap.zarr/
├── meta.json          ← Siêu dữ liệu (kích thước, số cấp, khoảng giá trị)
├── level_0/           ← Cấp 0 (50402×2638, chia thành 197×11 khối)
│   ├── 0.0.0          ← Khối hàng 0, cột 0 (nén)
│   ├── 0.0.1          ← Khối hàng 0, cột 1
│   └── ...
├── level_1/           ← Cấp 1 (25201×1319)
├── level_2/           ← Cấp 2 (12600×659)
└── ... cho đến level_8
```

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

### meta.json — "bản đồ" của kim tự tháp

```json
{
  "n_cells": 2638,
  "n_genes": 50402,
  "n_levels": 9,
  "levels": [[50402, 2638], [25201, 1319], ...],
  "vmin": 0.9648,    // Giá trị thấp nhất (cho tô màu)
  "vmax": 4.7932,    // Giá trị cao nhất
  "groups": [        // Thông tin cụm cho hiển thị khe
    {"id": "CD4 T cells", "size": 1144},
    {"id": "CD14+ Monocytes", "size": 480},
    ...
  ]
}
```

### Ưu điểm
- Trình duyệt chỉ tải cấp phù hợp với mức zoom → cực nhanh
- Zarr chia khối → đọc từng phần mà không cần tải toàn bộ
- Lưu trên đĩa, dùng lại được nhiều lần

### Nhược điểm
- Tốn dung lượng đĩa (tất cả 9 cấp ≈ 1.5× dữ liệu gốc)
- Gộp trung bình làm mất chi tiết ở cấp thấp — nhưng đó là mục đích
- Xây kim tự tháp tốn thời gian (vài phút cho dữ liệu thử nghiệm)

---

## Bước 4: Cắt thành ảnh PNG tĩnh (Tile Generation)

### Ý tưởng

Zarr lưu **số** (float). Trình duyệt cần **ảnh** (PNG). Ta cắt mỗi cấp của kim tự tháp thành các ảnh nhỏ 256×256 pixel, lưu thành file PNG trên đĩa.

```
Cấp 2 (12600 × 659):                    Cắt thành 50×3 = 150 ảnh:
┌───────────────────────────┐          data/tiles/default/2/
│                           │          ├── 0_0.png  (hàng 0, cột 0)
│     Ma trận 12600×659      │   ──→    ├── 0_1.png  (hàng 0, cột 1)
│                           │          ├── 0_2.png  (hàng 0, cột 2)
│                           │          ├── 1_0.png  (hàng 1, cột 0)
└───────────────────────────┘          └── ... (150 ảnh)
```

### Vì sao cần bước này?

- **PNG tĩnh** được phục vụ như ảnh bình thường — nhanh như CDN, không cần tính toán
- Trình duyệt cache ảnh tự động — zoom lại cùng vị trí = tức thì
- Tách biệt "chuẩn bị dữ liệu" (backend) và "hiển thị" (frontend)

### Chi tiết kỹ thuật — Mã hóa grayscale

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

### Dọn dẹp ô cũ (stale tile cleanup)

Trước khi tạo ô mới, xóa toàn bộ thư mục ô cũ:

```python
if base.exists():
    shutil.rmtree(base)  # Xóa sạch ô cũ!
base.mkdir(parents=True)
```

**Vì sao?** Nếu không xóa, ô từ lần xây trước (có thể khác thứ tự sắp xếp) vẫn còn → hiển thị sai.

### Ưu điểm
- Phục vụ ảnh tĩnh = cực nhanh (giống CDN)
- Trình duyệt tự cache
- Không tính toán khi người dùng xem

### Nhược điểm
- Tốn dung lượng đĩa (hàng nghìn file PNG)
- Phải tạo lại khi dữ liệu thay đổi
- Ô biên có padding (đã xử lý bằng `dataExtent`)

---

## Bước 5: Máy chủ phục vụ ảnh (FastAPI Server)

### Ý tưởng

Một máy chủ HTTP (FastAPI) đơn giản làm **trạm phân phát ảnh** — giống như một thư viện: trình duyệt yêu cầu ảnh nào, máy chủ trả file PNG tương ứng.

```
Trình duyệt:  "Cho tôi ảnh /tiles/2/0_2.png"
                    ↓
Máy chủ:      Tìm file data/tiles/default/2/0_2.png
                    ↓
              Trả về file PNG (256×256 grayscale)
```

### Vì sao cần bước này?

- Trình duyệt không thể đọc file trực tiếp từ đĩa máy chủ
- Cần một API để trình duyệt hỏi "metadata" (kích thước, số cấp, cụm)
- Máy chủ cũng có khả năng tạo **kim tự tháp tùy chỉnh** (chọn gen cụ thể)

### Các endpoint (đường dẫn API)

```
GET /api/meta              → Siêu dữ liệu (kích thước, cấp, khoảng giá trị, cụm)
GET /tiles/{level}/{row}_{col}.png  → Ảnh PNG tĩnh (chính)
GET /api/obs               → Tên tế bào + cụm louvain + tọa độ UMAP
GET /api/var               → Tên gen
GET /api/groups            → Danh sách cụm (id + kích thước)
POST /api/custom           → Tạo kim tự tháp tùy chỉnh (chọn gen)
GET /api/custom/{id}/tile  → Ảnh ô của kim tự tháp tùy chỉnh
```

```
┌───────────── Luồng phục vụ ảnh ─────────────┐
│                                              │
│  Trình duyệt                                 │
│     │                                        │
│     │  GET /tiles/2/0_2.png                   │
│     ↓                                        │
│  Vite Dev Proxy (chuy tiếp đến :8001)        │
│     │                                        │
│     ↓                                        │
│  FastAPI (server.py)                         │
│     │                                        │
│     │  Tìm: data/tiles/default/2/0_2.png     │
│     ↓                                        │
│  FileResponse (trả file PNG trực tiếp)       │
│     │                                        │
│     ↓                                        │
│  Trình duyệt nhận PNG → vẽ lên canvas        │
│                                              │
└──────────────────────────────────────────────┘
```

### Ưu điểm
- Đơn giản, nhanh (chỉ trả file tĩnh)
- FastAPI nhẹ, dễ mở rộng
- Proxy Vite trong khi phát triển = cùng nguồn (no CORS issues)

### Nhược điểm
- Phải chạy máy chủ riêng (không thể mở file HTML trực tiếp)
- Nếu dữ liệu thay đổi, phải tạo lại ô + khởi động lại máy chủ

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

### Chọn ô nhìn thấy (Tile Culling)

Mỗi khung hình, tính toán ô nào nằm trong khung nhìn:

```
┌───────────── Chọn ô nhìn thấy ─────────────┐
│                                              │
│    Khung nhìn (viewport)                     │
│  ┌────────────────────────┐                 │
│  │ ████ ████ ████ ████    │ ← Chỉ tải ô     │
│  │ ████ ████ ████ ████    │   trong khung    │
│  │ ████ ████ ████ ████    │                 │
│  └────────────────────────┘                 │
│    ↑ Ô ngoài khung = KHÔNG tải               │
│                                              │
│  Thuật toán: kiểm tra giao (intersection)    │
│  - Duyệt tất cả ô ở cấp đã chọn              │
│  - Giữ ô có bounds giao khung nhìn + lề      │
└──────────────────────────────────────────────┘
```

### Chọn cấp kim tự tháp (Level Selection)

```
Zoom = 0   (xem toàn bộ)  → Cấp 8 (thô nhất, 10×196)
Zoom = -4  (zoom ra)      → Cấp 4
Zoom = -8  (xa nhất)       → Cấp 8
Zoom = +2  (zoom vào)     → Cấp 0 (chi tiết nhất)

Công thức: level = floor(-zoom), giới hạn [0, maxLevel]
```

### Sắp xếp ô với khe cụm (SpatialLayout)

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

### Ưu điểm
- WebGL = 60 FPS với hàng nghìn ô
- Tự động culling + cache
- Pan/zoom mượt

### Nhược điểm
- deck.gl phức tạp, đường cong học tập cao
- Shader tùy chỉnh khó debug
- Phải quản lý nhiều lớp thủ công

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

### Luồng zoom

```
┌───────────── Luồng Zoom ─────────────┐
│                                       │
│  1. Người dùng cuộn chuột             │
│       ↓                               │
│  2. deck.gl cập nhật viewState.zoom   │
│       ↓                               │
│  3. computeVisibleTiles() chạy:       │
│     - Tính cấp = floor(-zoom)         │
│     - Tìm ô nhìn thấy ở cấp đó        │
│     - Áp dụng khe cụm (SpatialLayout) │
│       ↓                               │
│  4. Tạo GroupedHeatmapLayer mỗi ô     │
│       ↓                               │
│  5. Mỗi layer tải PNG từ máy chủ      │
│       ↓                               │
│  6. GPU shader tô màu + vẽ           │
│       ↓                               │
│  7. Heatmap cập nhật (60 FPS)        │
│                                       │
└───────────────────────────────────────┘
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

### Ưu điểm
- Trải nghiệm mượt, tức thì
- Đổi palette/khe không tải lại ảnh
- Hover cho thông tin chi tiết

### Nhược điểm
- Phải quản lý state phức tạp (fit-once guard, LUT async)
- Tải ô động có thể gây nhấp nháy khi mạng chậm

---

## Sơ đồ tổng thể kiến trúc

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        KIẾN TRÚC TOÀN DIỆN                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ╔══════════════════════ BACKEND (Python) ═════════════════════════╗        │
│  ║                                                                 ║        │
│  ║  File .h5ad (sinh học)                                          ║        │
│  ║       │                                                         ║        │
│  ║       ▼                                                         ║        │
│  ║  build_pyramid.py                                               ║        │
│  ║   1. Đọc h5ad → chọn lớp log_normalize                          ║        │
│  ║   2. Xoay ma trận: (gen, tế bào)                                ║        │
│  ║   3. Sắp xếp tế bào theo cụm (giảm dần kích thước)             ║        │
│  ║   4. Tính vmin/vmax (percentile 1-99)                          ║        │
│  ║   5. Xây kim tự tháp: gộp 2×2 mean pooling                     ║        │
│  ║   6. Lưu Zarr + meta.json                                      ║        │
│  ║       │                                                         ║        │
│  ║       ▼                                                         ║        │
│  ║  data/heatmap.zarr/                                             ║        │
│  ║   ├── level_0/ (50402×2638, 197×11 khối)                       ║        │
│  ║   ├── level_1/ ... level_8/                                    ║        │
│  ║   └── meta.json (kích thước, cấp, vmin/vmax, cụm)              ║        │
│  ║       │                                                         ║        │
│  ║       ▼                                                         ║        │
│  ║  generate_pyramid.py                                           ║        │
│  ║   1. Đọc Zarr + meta.json                                      ║        │
│  ║   2. Cắt mỗi cấp thành ô 256×256                               ║        │
│  ║   3. Mã hóa: giá trị → byte 1-255, NaN → byte 0                ║        │
│  ║   4. Lưu PNG grayscale + manifest.json                         ║        │
│  ║       │                                                         ║        │
│  ║       ▼                                                         ║        │
│  ║  data/tiles/default/                                            ║        │
│  ║   ├── 0/ (197×11 = 2167 ảnh)                                   ║        │
│  ║   ├── 1/ ... 8/                                                 ║        │
│  ║   └── manifest.json                                            ║        │
│  ║       │                                                         ║        │
│  ║       ▼                                                         ║        │
│  ║  server.py (FastAPI :8001)                                     ║        │
│  ║   ├── GET /tiles/{L}/{R}_{C}.png → FileResponse                ║        │
│  ║   ├── GET /api/meta → meta.json                                ║        │
│  ║   ├── GET /api/obs, /api/var, /api/groups                      ║        │
│  ║   └── POST /api/custom → kim tự tháp tùy chỉnh                 ║        │
│  ╚═════════════════════════════════════════════════════════════════╝        │
│                                    │ HTTP                                   │
│                                    ▼                                        │
│  ╔══════════════════════ FRONTEND (TypeScript) ═════════════════════╗      │
│  ║                                                                 ║      │
│  ║  Vite Dev Server (:5173) — proxy /api + /tiles → :8001         ║      │
│  ║       │                                                         ║      │
│  ║       ▼                                                         ║      │
│  ║  HeatmapView.tsx (React)                                        ║      │
│  ║   1. fetchMeta() → kích thước, cấp, cụm                        ║      │
│  ║   2. SpatialLayout → khe cụm (groupRawStarts vs groupWorld)    ║      │
│  ║   3. computeVisibleTiles() → ô nhìn thấy ở cấp phù hợp         ║      │
│  ║   4. createTileLayers() → GroupedHeatmapLayer mỗi ô             ║      │
│  ║   5. createGapOverlayLayers() → che khe                       ║      │
│  ║   6. createTileBorderLayer() → viền + hover                    ║      │
│  ║   7. createClusterAnnotationLayers() → tên cụm                ║      │
│  ║   8. createAxisLayers() → nhãn trục                            ║      │
│  ║       │                                                         ║      │
│  ║       ▼                                                         ║      │
│  ║  deck.gl (WebGL2)                                               ║      │
│  ║   ├── OrthographicView (pan/zoom 2D)                           ║      │
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
│                    (tương tác, zoom, hover, đổi màu)                        │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Tóm tắt: Tại sao kiến trúc này?

| Quy tắc | Ý tưởng | Lợi ích |
|---|---|---|
| Ô tĩnh PNG | Tạo ảnh trước, phục vụ như file tĩnh | Nhanh như CDN, cache trình duyệt |
| Grayscale + GPU LUT | Ảnh đen trắng, tô màu trên GPU | Đổi palette 0ms, tiết kiệm băng thông |
| Kim tự tháp đa cấp | Nhiều độ phân giải | Tải đúng chi tiết cho zoom hiện tại |
| Sắp xếp theo cụm | Nhóm tế bào cùng loại | Thấy cấu trúc sinh học |
| Khe cụm (SpatialLayout) | Tách 2 mảng raw/world | Ô đặt đúng vị trí, không nhầm |
| Intersection culling | Kiểm tra giao khung nhìn | Không bỏ sót ô, không tải thừa |
| dataExtent UV remap | Chỉ lấy phần dữ liệu ô biên | Không còn dải đen padding |

> **Kết luận:** Kiến trúc này biến một bảng số 133 triệu ô thành một heatmap tương tác mượt mà ở 60 FPS, bằng cách chia dữ liệu thành ô nhỏ, xây kim tự tháp đa cấp, và để GPU làm phần nặng nhất (tô màu).

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
                      ├── generate_pyramid.py → PNG tĩnh (Rule #1)
                      ├── server.py
                      │     ├── /api/tile (fallback động)
                      │     ├── /api/value (hover tooltip)
                      │     └── /api/custom (chọn gen → kim tự tháp tùy chỉnh)
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
build_pyramid:  Giữ toàn bộ ma trận trong RAM (500 MB) + dask → tốn RAM lớn
generate_pyramid: Đọc từng ô 256×256 (64 KB/ô) → cực nhẹ
```

Gộp = giữ h5ad + dask + PNG cùng lúc = tốn RAM gấp đôi.

#### 4. Ranh giới kiến trúc rõ

```
build_pyramid  = xử lý dữ liệu sinh học (backend pipeline)
generate_pyramid = tạo tài sản tĩnh (asset generation)
server.py      = phục vụ tài sản (static file server)
```

#### 5. Linh hoạt khi phát triển

```
Phát triển:  build_pyramid → server.py (/api/tile động, render theo yêu cầu)
Production:  build_pyramid → generate_pyramid → server.py (/tiles tĩnh, nhanh hơn)
```

**Tóm lại:** Zarr là **cơ sở dữ liệu**, PNG tĩnh là **cache**. Tách database và cache là pattern chuẩn trong kỹ thuật phần mềm.

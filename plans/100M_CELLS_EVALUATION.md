# 📊 Đánh giá Khả thi: Nâng cấp Heatmap lên 100 Triệu Tế bào

> Phân tích chi tiết đề xuất `UPDATE_100M_CELLS_INSTRUCTIONS.md` — cái gì khả thi, cái gì cần sửa, cái gì thiếu.

---

## Tổng quan

| Thông số | Hiện tại (PBMC 3k) | Mục tiêu 100M |
|---|---|---|
| Tế bào | 2.638 | 100.000.000 |
| Gen | 50.402 | 20.000 |
| Phần tử ma trận | 133 triệu | 2 nghìn tỷ (2 trillion) |
| Dữ liệu thô (sparse) | ~50 MB | ~250 GB |
| Số ô PNG tĩnh | ~3.000 | ~30 triệu+ |
| RAM cần thiết (dense) | 500 MB | ~8 TB (KHÔNG THỂ) |

---

## Đánh giá từng phần

### ✅ PHẦN 1: Loại bỏ Static PNG — KHẢ THI, ĐÚNG

**Đề xuất:** Xóa `generate_pyramid.py`, tạo PNG động qua FastAPI.

**Đánh giá: HOÀN TOÀN ĐÚNG.**

```
Vấn đề: 100M cells × 256 pixel/ô = ~390.000 cột ô
        × ~80 hàng ô (20K genes / 256) = ~31 triệu file PNG
        
→ Hệ điều hành chết (inode exhaustion, directory listing chậm)
→ Không thể lưu trữ, không thể backup
```

Giải pháp động (on-the-fly) là bắt buộc. Tuy nhiên cần bổ sung:

**⚠️ Thiếu: Cache layer ngoài RAM**
- `@lru_cache(maxsize=2048)` chỉ cache 2048 ô trong RAM (~128 MB)
- Khi zoom/pan, ô cũ bị đẩy ra → tải lại → nhấp nháy
- **Cần thêm:** Disk cache (LRU trên SSD) hoặc Redis để cache ô đã render
- **Cần thêm:** Pre-warm cache cho các ô ở cấp cao (thường xem nhất)

**⚠️ Thiếu: Tính toán vmin/vmax**
- Hiện tại `build_pyramid.py` tính vmin/vmax bằng percentile trên toàn ma trận
- Với 100M cells, không thể load toàn bộ để tính percentile
- **Cần:** Tính percentile theo từng chunk (dask) hoặc dùng approximate percentile

---

### ✅ PHẦN 2: Out-of-Core Processing (Backed Mode) — KHẢ THI, CẦN SỬA

**Đề xuất:** `anndata.read_h5ad(h5ad_path, backed='r')` + Dask

**Đánh giá: ĐÚNG HƯỚNG, nhưng code mẫu có vấn đề.**

**Vấn đề 1: Sparse → Dask không trực tiếp**
```python
# Code đề xuất:
dask_matrix = da.from_zarr(adata.layers["log_normalize_zarr"])
# LỖI: adata.layers không phải zarr, là sparse CSR
# backed mode chỉ lazy-read X, không tự động chuyển sang dask
```

**Sửa:**
```python
adata = anndata.read_h5ad(h5ad_path, backed='r')
# Dask đọc sparse từng chunk
import dask.array as da
from dask.array import from_delayed
# Cần custom reader cho sparse CSR → dask chunks
```

**Vấn đề 2: Transpose out-of-core**
```python
# Hiện tại (OOM):
mat = mat.toarray().T  # Dense transpose = 8TB RAM

# Cần: Transpose lazy qua dask
# Dask có thể transpose lazy: arr.T tạo view, không copy
# Nhưng sparse transpose cần CSR→CSC conversion
```

**Vấn đề 3: Cluster sorting out-of-core**
```python
# Hiện tại:
order = _cluster_order(adata)  # Cần toàn bộ obs (OK, obs nhỏ)
mat = mat[:, order]  # Reorder cột = cần toàn bộ ma trận

# 100M: Không thể reorder toàn bộ
# Cần: Viết từng chunk đã reorder, hoặc sort index trước rồi lazy gather
```

---

### ✅ PHẦN 3: Dynamic Tile Generation — KHẢ THI, CẦN TỐI ƯU

**Đề xuất:** FastAPI + PIL, render PNG động, LRU cache 2048

**Đánh giá: ĐÚNG, nhưng < 5ms là THÁCH THỨC.**

```
Phân tích thời gian render 1 ô:
┌──────────────────────────────────┬──────────┐
│ Bước                             │ Thời gian│
├──────────────────────────────────┼──────────┤
│ Đọc 256×256 chunk từ Zarr (SSD)  │ 0.1-1ms  │
│ Normalize float → uint8          │ 0.1ms    │
│ Tạo PIL Image + encode PNG       │ 1-3ms    │
│ FastAPI response overhead        │ 0.5-1ms  │
├──────────────────────────────────┼──────────┤
│ Tổng                             │ 2-6ms    │
└──────────────────────────────────┴──────────┘
```

**< 5ms khả thi** nếu:
- Zarr trên NVMe SSD (0.1ms read)
- Dùng `optimize=False` (đã có)
- Dùng Pillow-SIMD hoặc `imagecodecs` thay PIL thường

**⚠️ Thiếu: Worker pool / async**
- FastAPI đồng bộ = 1 request tại lúc
- 100M cells → nhiều ô tải cùng lúc (deck.gl tải song song)
- **Cần:** Async endpoint hoặc worker pool (uvicorn workers)

**⚠️ Thiếu: Normalize function**
- Code đề xuất gọi `normalize_to_bytes(block)` nhưng không định nghĩa
- Cần vmin/vmax (xem vấn đề ở Phần 1)

---

### ✅ PHẦN 4: RTC Coordinate System — KHẢ THI, QUAN TRỌNG

**Đề xuất:** Dùng `COORDINATE_SYSTEM.CARTESIAN` + RTC

**Đánh giá: ĐÚNG, đây là vấn đề thực.**

```
Float32 precision:
- 23 bit mantissa = 8.388.608 giá trị nguyên chính xác
- X = 100.000.000 >> 8.388.608
- → Jittering: các pixel nhảy sai vị trí 1-16 pixel

Giải pháp RTC (Relative-To-Center):
- Thay vì dùng tọa độ tuyệt đối [0, 100M]
- Dùng tọa độ tương đối so với tâm khung nhìn
- [center - viewport/2, center + viewport/2] → luôn < 1M → Float32 OK
```

**⚠️ Code đề xuất chưa đúng:**
```typescript
// Đề xuất:
this.setState({ coordinateSystem: COORDINATE_SYSTEM.CARTESIAN });
// Vấn đề: CARTESIAN không tự động bật RTC
// Deck.gl 9.x dùng modelMatrix hoặc projectionParams cho RTC
```

**Cần sửa:**
```typescript
// Deck.gl 9.x: dùng coordinateOrigin + coordinateSystem
new OrthographicView({
  coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
  coordinateOrigin: [centerX, centerY, 0], // RTC origin
})
// Hoặc: offset target trong viewState để luôn gần 0
```

---

### ✅ PHẦN 5: Cluster-Level SpatialLayout — ĐÃ CÓ, CẦN TỐI ƯU

**Đề xuất:** Binary search trên cluster metadata, không tạo mảng 100M

**Đánh giá: ĐÚNG, và code hiện tại ĐÃ LÀM ĐIỀU NÀY.**

```typescript
// SpatialLayout.ts hiện tại (đã có binary search):
mapColToWorldX(colIndex: number): number {
  let lo = 0, hi = this.groupRawStarts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    // ... binary search
  }
}
```

Code hiện tại đã hoạt động ở cluster-level (chỉ ~hundreds of clusters). **Không cần thay đổi lớn**, chỉ cần đảm bảo:
- `groupRawStarts` dùng `Float64` (không phải `number` JS = Float64 mặc định ✓)
- `totalWorldWidth` có thể vượt 2^53? → 100M + gaps < 2^53 ✓ (JS number an toàn đến 9×10^15)

---

## ❌ PHẦN THIẾU: Những gì đề xuất BỎ QUÊN

### 1. Sparse Matrix Handling
- 100M cells × 20K genes = 2 trillion phần tử
- Sparse (~95% zeros) → ~100 tỷ non-zero
- Đề xuất không nói cách đọc sparse out-of-core
- **Cần:** `dask.array.from_sparse` hoặc chunked sparse reader

### 2. Pyramid Coarsening cho Sparse
- `da.coarsen(np.nanmean, ...)` cần dense array
- Sparse mean pooling phức tạp hơn (cần sum + count)
- **Cần:** Custom sparse coarsen function

### 3. Metadata Storage
- `cell_order` (permutation array) = 100M × 8 byte = 800 MB
- `cell_ids` = 100M × ~20 byte = 2 GB (string)
- **Cần:** Không lưu cell_order trong meta.json (quá lớn)
- **Cần:** Lazy fetch cell names (chỉ fetch khi zoom đủ)

### 4. Frontend Memory
- `obs.cell_ids` = 100M strings → OOM browser
- **Cần:** Chỉ fetch cell/gene names cho vùng đang xem
- **Cần:** `maxCacheSize: 300` cho TileLayer (đề xuất có, đúng)

### 5. Network Bandwidth
- 100M cells → nhiều ô hơn → nhiều HTTP request hơn
- Deck.gl tải ~50-200 ô/khung nhìn
- **Cần:** HTTP/2 (multiplexing) hoặc WebSocket batch

### 6. Build Time
- 100M cells × 20K genes, 9 levels
- Dask out-of-core: mỗi chunk 256×256 = 256KB
- Tổng: ~8M chunks × 9 levels = 72M chunk operations
- **Ước tính:** Vài giờ đến vài ngày (tùy phần cứng)
- **Cần:** Parallel workers, progress bar, checkpoint/resume

---

## 📊 Bảng đánh giá tổng hợp

| Đề xuất | Khả thi | Mức độ ưu tiên | Ghi chú |
|---|---|---|---|
| Xóa static PNG, dùng dynamic | ✅ Hoàn toàn | 🔴 Cao | Bắt buộc, không có lựa chọn |
| Backed mode + Dask | ✅ Đúng hướng | 🔴 Cao | Code mẫu cần sửa nhiều |
| Dynamic tile + LRU cache | ✅ Khả thi | 🔴 Cao | < 5ms OK với NVMe, cần disk cache |
| RTC coordinate system | ✅ Quan trọng | 🔴 Cao | Code đề xuất chưa đúng, cần sửa |
| Cluster-level SpatialLayout | ✅ Đã có | 🟢 Thấp | Code hiện tại đã làm đúng |
| Sparse handling | ❌ Thiếu | 🔴 Cao | Đề xuất bỏ qua hoàn toàn |
| Metadata storage | ❌ Thiếu | 🟡 Trung bình | cell_order 800MB không hợp lệ |
| Frontend memory | ❌ Thiếu | 🟡 Trung bình | Cần lazy fetch cell names |
| Build time | ❌ Thiếu | 🟡 Trung bình | Cần checkpoint/resume |
| Network | ❌ Thiếu | 🟡 Trung bình | Cần HTTP/2 hoặc batch |

---

## 🎯 Kết luận

**Đề xuất đúng hướng (~70%)** nhưng **thiếu chi tiết thực thi (~30%)**:

### Có thể làm ngay (khả thi cao):
1. ✅ Xóa static PNG → dynamic tile server
2. ✅ Backed mode + Dask (cần sửa code)
3. ✅ RTC coordinate system (cần sửa code)
4. ✅ SpatialLayout đã sẵn sàng

### Cần nghiên cứu thêm trước khi làm:
1. ⚠️ Sparse matrix out-of-core pipeline (phức tạp nhất)
2. ⚠️ Disk cache layer cho dynamic tiles
3. ⚠️ Lazy metadata fetch (cell names theo vùng)
4. ⚠️ Build time optimization (checkpoint/resume)

### Rủi ro lớn nhất:
- **Sparse → Dask pipeline** là phần khó nhất, đề xuất bỏ qua
- **Build time** có thể tính bằng ngày, cần chiến lược checkpoint
- **Float32 precision** cần test thực tế ở 100M (RTC code đề xuất chưa đúng)

**Khuyến nghị:** Bắt đầu với 1M cells (1 triệu) trước để validate pipeline, rồi tăng dần 10M → 100M. Không nhảy thẳng lên 100M.

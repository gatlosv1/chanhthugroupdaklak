# NLChanhthu

## Trang In Nhãn

Trang `label.html` dùng chung Firebase Auth và Firestore của hệ thống. Người dùng phải có hồ sơ tại `users/{uid}` với `role` là `admin` hoặc `staff`.

Các collection được ứng dụng sử dụng:

- `thanhpham/{id}`: `stt`, `maSP`, `tenTP`, `loai`, `createdAt`, `updatedAt`. Admin quản lý; mọi người đã đăng nhập được đọc.
- `printHistory/{id}`: `maBTP`, `sku`, `tenTP`, `toSanXuat`, `quyCach`, `soLuong`, `sttDau`, `sttCuoi`, `productKey`, `counterDate`, `createdBy`, `timestamp`.
- `productCounters/{yyyy-mm-dd__productKey}`: STT theo ngày và thành phẩm, gồm `nextSTT`, thông tin lần in gần nhất, `updatedBy`, `updatedAt`.
- `settings/dropdowns`: các mảng `toSanXuat`, `nhaSX`, `loaiHang`, `vungNguyenLieu`. Admin quản lý.
- `production/{id}`: dữ liệu sản xuất hiện có; trường `lot` và `productionDate` được dùng cho cửa sổ chọn lot.

Không cần tạo collection thủ công; Firestore tạo document khi có lần ghi đầu tiên. Trước khi sử dụng, triển khai rules:

```powershell
firebase deploy --only firestore:rules
```

Sau khi kiểm tra, triển khai website bằng cấu hình Firebase Hosting hiện tại:

```powershell
firebase deploy --only hosting
```

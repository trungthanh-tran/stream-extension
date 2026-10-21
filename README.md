# stream-extension — Video Tải Về

Extension Chrome (Manifest V3) phát hiện video trên trang hiện tại và phủ nút **Tải về** lên mỗi video. Không cần build, không cần app ngoài: ghép và chuyển định dạng chạy ngay trong extension bằng ffmpeg.wasm.

## Tính năng
- Quét mọi thẻ `<video>` (kể cả trong iframe và shadow DOM), phủ nút "Tải về" góc trên trái video, kèm độ phân giải.
- **File trực tiếp** (mp4/webm/...): Chrome tải thẳng xuống đĩa. Server chặn hotlink (đòi Referer, ví dụ 8movie.com) thì tự chuyển sang tải bằng fetch kèm Referer của trang, hiện % trên nút.
- **Video blob/MSE** (hls.js, dash.js, video.js...): background bắt URL media qua `webRequest`, ưu tiên file trực tiếp, rồi HLS, rồi DASH.
- **HLS** (.m3u8): chọn luồng chất lượng cao nhất, tải các đoạn song song, giải mã AES-128 nếu có, gộp rồi remux sang **.mp4** chuẩn.
- **DASH** (.mpd tĩnh): SegmentTemplate ($Number$/$Time$/SegmentTimeline), SegmentList, SegmentBase; chọn video bitrate cao nhất + audio (ưu tiên tiếng Việt); ghép hình + tiếng thành **một file .mp4**.
- **Ghi MediaSource** (nút đỏ "Ghi" cạnh nút Tải về, chỉ hiện với video blob): hook `SourceBuffer.appendBuffer` trong trang, lưu lại đúng dữ liệu player đã nhận, ghép hình + tiếng bằng ffmpeg. Dùng cho site giấu URL, token đổi liên tục, hoặc khi không bắt được gì qua mạng. Cần phát video từ đầu đến cuối (nút hiện ✓ khi video đã ended), không tua.
- **Tải cả bộ** (bảng gợi ý góc dưới phải, mọi trang): khi "nghi ngờ" trang là một bộ nhiều tập thì hiện danh sách tập, mỗi tập một nút tải lẻ, cộng khoảng từ–đến và nút Tải cả bộ. Lưu vào thư mục con mang tên bộ (`Tên bộ/Tap 01.mp4`). Nghi ngờ theo ba dấu hiệu, không gắn với cấu trúc URL của site nào:
  - Trang nhúng sẵn ≥3 URL media (mp4/m3u8/mpd) cùng thư mục, số tập lấy từ tên file (kiểu 8movie nhúng JSON cả 50 tập).
  - ≥3 link cùng mẫu URL chỉ khác một số (và chứa trang hiện tại hoặc nhãn tăng dần).
  - ≥3 link có nhãn kiểu tập: 第01集, Tập 1, Episode 3, EP03, E03, hoặc số thuần trong vùng có class/id gợi ý danh sách tập.
  Với link trang tập, extension mở từng tập ở tab ẩn, lấy link video rồi tải, xong đóng tab. Tải tuần tự từng tập, có nút Dừng.
  Bấm **Tải cả bộ** sẽ hỏi chọn **một thư mục** (File System Access API), rồi ghi thẳng từng tập vào đó (`Tap 01.mp4`, `Tap 02.mp4`...), không qua hộp thoại Save As của Chrome dù bật "Hỏi nơi lưu mỗi file". Dữ liệu được ghi theo luồng từng khúc 2 MB nên không giữ cả file trong RAM. Giữ nguyên tab trong lúc tải vì quyền ghi thư mục chỉ sống trong trang đó. Nút Tải lẻ từng tập vẫn dùng cơ chế tải thường của Chrome.
- Popup (icon extension): liệt kê video trên trang + URL media bắt được qua mạng, bấm Tải về / Ghi từng cái.
- Nếu ffmpeg.wasm lỗi, extension tự lùi về file gốc (.ts, hoặc 2 file video/audio rời).

## Cài đặt
1. Mở `chrome://extensions`, bật **Developer mode**.
2. **Load unpacked** → chọn thư mục này.

Edge, Brave, Cốc Cốc cài cùng cách. Sau khi sửa code, bấm nút tải lại trên thẻ extension.

## Giới hạn
- Không hỗ trợ DRM (Widevine/PlayReady/FairPlay): YouTube, Netflix, FPT Play, VieON... không tải được. MPD có `ContentProtection` sẽ báo lỗi ngay.
- DASH live (`type="dynamic"`) chưa hỗ trợ.
- Tải qua fetch/HLS/DASH/Ghi giữ toàn bộ file trong RAM trước khi lưu, ffmpeg.wasm cần thêm khoảng 2 lần dung lượng file. Phù hợp file dưới ~1 GB.
- Ghi MediaSource chỉ có phần đã phát; tua đi tua lại sẽ gây trùng đoạn.

## Cấu trúc
| File | Vai trò |
|---|---|
| `inject.js` | Chạy ở MAIN world, hook MediaSource để ghi dữ liệu |
| `content.js` | Quét video, nút phủ, gửi dữ liệu MSE sang offscreen |
| `series.js` | Phát hiện bộ nhiều tập, bảng tải lẻ / tải cả bộ |
| `background.js` | Bắt URL media, Referer rule (DNR), điều phối tải, hàng đợi tải cả bộ |
| `offscreen.js` | HLS, DASH, fetch có Referer, lắp MSE, ffmpeg.wasm |
| `lib/ffmpeg/` | @ffmpeg/ffmpeg 0.12.15 (ESM) + @ffmpeg/core 0.12.10 (ESM, ~32 MB) |
| `popup.*` | Danh sách video / media trên trang |

## Tạo lại icon
```
pip install pillow
python make_icons.py
```

# stream-extension — Video Tải Về

Extension Chrome (Manifest V3) phát hiện video trên trang hiện tại và phủ nút **Tải về** lên mỗi video.

## Tính năng
- Quét mọi thẻ `<video>` (kể cả trong iframe và shadow DOM), phủ nút "Tải về" góc trên trái video, kèm độ phân giải.
- Video có `src` trực tiếp (mp4/webm/...): tải ngay qua Chrome Downloads.
- Video dùng blob/MSE (hls.js, video.js...): background bắt URL media qua `webRequest`, ưu tiên file trực tiếp, sau đó HLS.
- HLS (.m3u8): chọn luồng chất lượng cao nhất, tải các đoạn song song, giải mã AES-128 nếu có, gộp thành một file `.ts` hoặc `.mp4` (fMP4), hiện % tiến trình trên nút.
- Popup (icon extension): liệt kê video trên trang + URL media bắt được qua mạng, bấm tải từng cái.

## Cài đặt
1. Mở `chrome://extensions`, bật **Developer mode**.
2. **Load unpacked** → chọn thư mục này.

## Giới hạn
- Không hỗ trợ DRM (Widevine) và DASH (.mpd); YouTube/Netflix... không tải được.
- Video blob chưa phát: hãy phát vài giây để extension bắt được URL.
- File HLS gộp là `.ts`; muốn `.mp4` chạy `ffmpeg -i file.ts -c copy file.mp4`.

## Tạo lại icon
```
pip install pillow
python make_icons.py
```

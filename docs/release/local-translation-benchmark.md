# Local translation benchmark

Measured 2026-10-16. These numbers are from real Bergamot inference on the pinned `en-tr` tiny model. They are not mocked translations. No BLEU score was computed in this repository.

Two runtimes are reported separately. The Node numbers are not Chrome heap numbers.

## Node CPU/WASM

Command: `npx tsx scripts/p9.2-local-translation-bench.mjs`. Runtime: `node-worker-threads`. WebGPU: false.

| Measurement | Value |
| --- | --- |
| WASM init | 67 ms |
| Model load | 55 ms |
| First translation | 133 ms, `Hello, how are you?` → `Merhaba, nasılsın?` |
| Warm median / min / max | 12 ms / 7 ms / 25 ms |
| RSS before | 120,766,464 |
| RSS after model load | 257,982,464 |
| RSS after the batch | 485,916,672 |

RSS is the whole Node process. It includes duplicated buffers and the worker's 128 MB workspace. It is not a browser tab measurement.

## Extension runtime in Brave

Isolated temporary profile. Brave reported `Chrome/155.0.0.0`. Extension id `clnlckalpdampejifebphhjaobknfjfj`. The user's normal Brave profile was not opened. YouTube was not opened. Report: the harness `scripts/p9.2-browser-inference.mjs`.

`performance.memory` stayed null in the service worker with `--enable-precise-memory-info`. No Chrome heap figure is claimed.

`navigator.gpu` was true. Bergamot did not use it. CPU/WASM is the compatibility path, and it is the path that produced the Turkish text below.

| Measurement | Value |
| --- | --- |
| Model download until "Model bu cihazda hazır" | 4,616 ms |
| Reported cached size | 15,101,045 bytes, `persisted: true` |
| Cold `Hello, how are you?` | 209 ms → `Merhaba, nasılsın?` |
| Warm `The meeting starts at 3.` | 26 ms → `Toplantı 3'te başlıyor.` |
| Same line after cancel | 175 ms → `Toplantı 3'te başlıyor.` |
| Relaunch with the model host blocked by Playwright, cache intact | 199 ms → `Merhaba, nasılsın?` |
| Popup `requestAnimationFrame` max gap during the cold call | 19 ms |
| Cloud Translation requests | 0 |
| Unofficial translate requests | 0 |

The 209 ms cold call is the first translation after download. It includes worker startup. The download itself does not open the WASM heap.

Playwright recorded 0 requests to the Mozilla model host. Fetches from the offscreen document were not visible to that listener, and `route.abort` did not stop them. The download evidence is the ready status, the byte count, and the later relaunch that still translated while Playwright was aborting that host. The corrupt-cache proof used a separate host-resolver rule. See `docs/release/local-translation-browser-acceptance.md`.

## Quality against retained cues

Short, complete sentences came out as usable Turkish. Rolling caption fragments did not. Examples below are the model output next to a retained human or prior Turkish line where one exists. This is not a score.

| Source | Local output | Retained Turkish, when one was kept |
| --- | --- | --- |
| Hello, how are you? | Merhaba, nasılsın? | |
| The meeting starts at three and we still need the final numbers before anyone leaves. | Toplantı üçe başlıyor ve kimse ayrılmadan önce hala son sayılara ihtiyacımız var. | |
| A neural network compresses the next word by predicting it. | Bir sinir ağı bir sonraki kelimeyi tahmin ederek sıkıştırıyor. | |
| Ada Lovelace wrote notes on the analytical engine. | Ada Lovelace analitik motorla notlar yazdı. | |
| The CPU and GPU share the same memory bus. | CPU ve GPU aynı bellek otobüslerini paylaşıyor. | Wrong sense: bus became the vehicle. |
| Can you hear the original audio after we stop? | Durduğumuzdan sonra orijinal sesi duyabiliyor musunuz? | |
| The sample rate is 48000 and the delay was 3.5 seconds. | Örnek oranı 48000 ve gecikme 3.5 saniyedir. | |
| I think we should um go now. | Bence şimdi gitmeliyiz. | The hesitation was dropped. |
| if you can predict uh sort of the next word | Bir sonraki kelimeyi tahmin edebilirseniz | Incomplete clause, rendered as a full sentence. |
| relationship between prediction and compression which is why I sort of allude to this neural | Tahmin ve sıkıştırma arasındaki ilişki, bu yüzden bu nöral için bir çeşit | tahmin ve sıkıştırma arasındaki ilişki, bu yüzden bir nevi bu sinirselden bahsediyorum |
| compression of the internet um because if you can predict | İnternetin sıkışma nedeni çünkü tahmin edebiliyorsanız | internetin sıkıştırılması çünkü tahmin edebiliyorsanız |
| if you can predict uh sort of the next word very accurately uh you can use that to compress | Bir sonraki kelimeyi çok doğru bir şekilde tahmin edebiliyorsanız, bunu sıkıştırmak için kullanabilirsiniz. | eğer bir sonraki kelimeyi çok doğru tahmin edebiliyorsan bunu sıkıştırmak için kullanabilirsin |
| magical artifact is that basically the next word predition task | Sihirlü eser, temelde bir sonraki kelime yırtıda görevdir. | büyülü eser, temelde bir sonraki kelime tahmin görevidir |

Per-cue translation is unchanged. Sentence reconstruction stays off. Latency on these Node lines, after the first call, was 7–25 ms.

## Not measured

- First Turkish audio delay on a YouTube watch page
- Scheduler drift
- CPU contention between this translator and Antalia or EMA
- A five-minute background dub
- WebGPU translation speed. The engine has no WebGPU path.
- A Chrome heap snapshot

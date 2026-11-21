package codec

import (
	"bytes"
	"fmt"
	"math/rand"
	"strings"
	"testing"
	"time"
)

// rasterize draws a QR module matrix as a luminance image: scale px per module, a white
// quiet zone of 4 modules, centred in a w x h dark frame (like a phone camera view).
func rasterize(size int, bits []byte, scale, w, h int) []byte {
	lum := make([]byte, w*h)
	for i := range lum {
		lum[i] = 30
	}
	side := (size + 8) * scale
	x0, y0 := (w-side)/2, (h-side)/2
	for y := 0; y < side; y++ {
		for x := 0; x < side; x++ {
			mx, my := x/scale-4, y/scale-4
			v := byte(255)
			if mx >= 0 && my >= 0 && mx < size && my < size && bits[my*size+mx] == 1 {
				v = 0
			}
			lum[(y0+y)*w+x0+x] = v
		}
	}
	return lum
}

func allBytes(n int) []byte {
	b := make([]byte, n)
	for i := range b {
		b[i] = byte(i)
	}
	return b
}

func TestPackUnpack(t *testing.T) {
	name := "<img src=x onerror=alert(1)> ทดสอบ.bin"
	data := allBytes(1000)
	gotName, gotData, err := Unpack(Pack(name, data))
	if err != nil || gotName != name || !bytes.Equal(gotData, data) {
		t.Fatalf("round trip: %q %v %v", gotName, len(gotData), err)
	}
	for _, bad := range [][]byte{nil, []byte("LD"), []byte("XXXX\x00\x05ab"), []byte("LDQ1\xff\xffab")} {
		if _, _, err := Unpack(bad); err == nil {
			t.Errorf("Unpack(%q) accepted a broken container", bad)
		}
	}
}

func TestRoundTripThroughQR(t *testing.T) {
	name := "<b>ไฟล์</b>.bin"
	data := allBytes(1024) // every byte value, four times
	s, err := NewSender(name, data, 200)
	if err != nil {
		t.Fatal(err)
	}
	r := NewReceiver()
	var st Status
	for i := 0; i < s.Len() && !st.Done; i++ {
		size, bits, err := Matrix(s.Frame(i))
		if err != nil {
			t.Fatal(err)
		}
		text, err := Scan(rasterize(size, bits, 6, 1080, 1920), 1080, 1920)
		if err != nil {
			t.Fatalf("frame %d: scan: %v", i, err)
		}
		if text != s.Frame(i) {
			t.Fatalf("frame %d: scanned text differs from the frame", i)
		}
		if st, err = r.Feed(text); err != nil {
			t.Fatalf("frame %d: feed: %v", i, err)
		}
	}
	gotName, gotData, ok := r.Result()
	if !ok || gotName != name || !bytes.Equal(gotData, data) {
		t.Fatalf("result ok=%v name=%q len=%d", ok, gotName, len(gotData))
	}
}

// Encode emits a fixed set of LT blocks; every file size must be decodable from them.
func TestEveryChunkCountCompletes(t *testing.T) {
	for _, chunkLen := range []int{100, 300} {
		for chunks := 1; chunks <= 120; chunks++ {
			for _, delta := range []int{-1, 0, 1} {
				// pick a payload whose base64 container is about chunks*chunkLen long
				n := (chunks*chunkLen)*3/4 - 40 + delta
				if n < 0 {
					n = 0
				}
				data := make([]byte, n)
				rand.New(rand.NewSource(int64(chunks))).Read(data)
				s, err := NewSender("f", data, chunkLen)
				if err != nil {
					t.Fatal(err)
				}
				r := NewReceiver()
				for i := 0; i < s.Len(); i++ {
					if _, err := r.Feed(s.Frame(i)); err != nil {
						t.Fatal(err)
					}
				}
				if _, got, ok := r.Result(); !ok || !bytes.Equal(got, data) {
					t.Fatalf("chunkLen %d, %d bytes (~%d chunks): not decodable from all %d frames", chunkLen, n, chunks, s.Len())
				}
			}
		}
	}
}

func TestHostileFramesAreRejectedWithoutPanic(t *testing.T) {
	r := NewReceiver()
	for _, f := range []string{
		"", "|", "hello", "1/2/3", "0/0/0|x", "0/100/0|x", "-1/100/50|x", "1/0/50|x",
		"1/100/99999999999|x", "1/100/2000000000|x", "1/999999/50|x", "a/b/c|x",
		"1/100/50|" + strings.Repeat("A", 101), // payload longer than chunkLen
	} {
		if _, err := r.Feed(f); err == nil {
			t.Errorf("Feed(%.30q) accepted", f)
		}
	}
	// still usable afterwards
	s, _ := NewSender("ok.txt", []byte("still works"), 100)
	for i := 0; i < s.Len(); i++ {
		r.Feed(s.Frame(i))
	}
	if name, data, ok := r.Result(); !ok || name != "ok.txt" || string(data) != "still works" {
		t.Fatalf("receiver broken after hostile frames: %v %q", ok, data)
	}
}

func TestSwitchingFilesRestartsCleanly(t *testing.T) {
	a := make([]byte, 5000)
	b := make([]byte, 7000)
	rand.Read(a)
	rand.Read(b)
	sa, _ := NewSender("a.bin", a, 200)
	sb, _ := NewSender("b.bin", b, 200)
	r := NewReceiver()
	for i := 0; i < sa.Len()/3; i++ {
		r.Feed(sa.Frame(i))
	}
	var st Status
	for i := 0; i < sb.Len(); i++ {
		st, _ = r.Feed(sb.Frame(i))
	}
	if name, data, ok := r.Result(); !ok || name != "b.bin" || !bytes.Equal(data, b) || !st.Done {
		t.Fatalf("after switching: ok=%v name=%q", ok, name)
	}
}

func TestProgressRisesAndCaps(t *testing.T) {
	data := make([]byte, 20000)
	rand.Read(data)
	s, _ := NewSender("p", data, 300)
	r := NewReceiver()
	last := -1.0
	for i := 0; i < s.Len(); i++ {
		st, err := r.Feed(s.Frame(i))
		if err != nil {
			t.Fatal(err)
		}
		if st.Progress < last {
			t.Fatalf("progress went down: %v -> %v", last, st.Progress)
		}
		if !st.Done && st.Progress >= 1 {
			t.Fatalf("progress %v before done", st.Progress)
		}
		if st.Done {
			if st.Progress != 1 {
				t.Fatalf("done but progress %v", st.Progress)
			}
			return
		}
		last = st.Progress
	}
	t.Fatal("never completed")
}

func TestRejectsFilesOverTheLimit(t *testing.T) {
	if _, err := NewSender("big", make([]byte, MaxFileSize+1), 300); err == nil {
		t.Fatal("accepted a file over MaxFileSize")
	}
}

// Not a pass/fail check: how long one camera-sized scan and a max-size decode take here.
func TestCost(t *testing.T) {
	s, _ := NewSender("c", make([]byte, 600), 300)
	size, bits, _ := Matrix(s.Frame(0))
	lum := rasterize(size, bits, 8, 1080, 1920)
	start := time.Now()
	for i := 0; i < 5; i++ {
		if _, err := Scan(lum, 1080, 1920); err != nil {
			t.Fatal(err)
		}
	}
	scan := time.Since(start) / 5

	data := make([]byte, MaxFileSize)
	rand.Read(data)
	start = time.Now()
	big, err := NewSender("max", data, 600)
	if err != nil {
		t.Fatal(err)
	}
	enc := time.Since(start)
	r := NewReceiver()
	start = time.Now()
	for i := 0; i < big.Len(); i++ {
		r.Feed(big.Frame(i))
	}
	_, got, ok := r.Result()
	dec := time.Since(start)
	if !ok || !bytes.Equal(got, data) {
		t.Fatal("max-size file did not decode")
	}
	t.Log(fmt.Sprintf("scan 1080x1920: %v/frame; %d KB file: %d frames, encode %v, decode %v", scan, MaxFileSize/1024, big.Len(), enc, dec))
}

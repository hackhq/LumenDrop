package codec

import (
	"fmt"
	"math/rand"
	"os"
	"testing"
)

// degrade blurs (box, radius r), lifts blacks, adds noise: a rough phone-camera capture.
func degrade(lum []byte, w, h, r int, seed int64) []byte {
	noise := 6
	if os.Getenv("NOISE") != "" {
		fmt.Sscan(os.Getenv("NOISE"), &noise)
	}
	out := make([]byte, len(lum))
	rng := rand.New(rand.NewSource(seed))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			sum, n := 0, 0
			for dy := -r; dy <= r; dy++ {
				for dx := -r; dx <= r; dx++ {
					yy, xx := y+dy, x+dx
					if yy >= 0 && yy < h && xx >= 0 && xx < w {
						sum += int(lum[yy*w+xx])
						n++
					}
				}
			}
			v := 40 + sum/n*190/255 + int(rng.NormFloat64()*float64(noise))
			out[y*w+x] = byte(max(0, min(255, v)))
		}
	}
	return out
}

// Run with SWEEP=1 to print which chunk sizes survive which blur on a ~900 px wide QR.
func TestChunkSizeSweep(t *testing.T) {
	if os.Getenv("SWEEP") == "" {
		t.Skip("set SWEEP=1")
	}
	for _, chunk := range []int{150, 250, 400, 600, 800, 1000, 1300} {
		s, _ := NewSender("s", make([]byte, 40000), chunk)
		size, bits, _ := Matrix(s.Frame(3))
		scale := 900 / (size + 8)
		line := ""
		for _, r := range []int{1, 2, 3, 4, 5} {
			ok := 0
			for seed := int64(0); seed < 4; seed++ {
				img := degrade(rasterize(size, bits, scale, 1080, 1920), 1080, 1920, r, seed)
				if text, err := scan(img, 1080, 1920, os.Getenv("HARDER") != ""); err == nil && text == s.Frame(3) {
					ok++
				}
			}
			line += " blur" + string(rune('0'+r)) + ":" + string(rune('0'+ok)) + "/4"
		}
		t.Logf("chunk %4d: %3d modules, %2d px/module |%s", chunk, size, scale, line)
	}
}

// Package codec moves a named file through animated QR codes using the txqr protocol
// (fountain-coded frames, github.com/divan/txqr). It is compiled to WebAssembly for the
// browser (see ../cmd/wasm) and tested natively.
package codec

import (
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/makiuchi-d/gozxing"
	zqrcode "github.com/makiuchi-d/gozxing/qrcode"
	"github.com/skip2/go-qrcode"

	"lumendrop/qr/txqr"
)

const (
	// MaxFileSize bounds what one QR transfer may carry: QR mode moves a few KB per
	// second, and the whole file is held in memory on both sides.
	MaxFileSize = 1 << 20

	MinChunk = 32
	MaxChunk = 2048

	magic   = "LDQ1"
	maxName = 255
)

// The txqr payload is the base64 of this container (as txqr's own tools base64 their input):
// "LDQ1" | name length (uint16, big endian) | name (UTF-8) | file bytes.
var maxEncoded = base64.StdEncoding.EncodedLen(len(magic) + 2 + maxName + MaxFileSize)

// Pack wraps a file name and its bytes into the container.
func Pack(name string, data []byte) []byte {
	if len(name) > maxName {
		name = strings.ToValidUTF8(name[:maxName], "")
	}
	out := make([]byte, 0, len(magic)+2+len(name)+len(data))
	out = append(out, magic...)
	out = binary.BigEndian.AppendUint16(out, uint16(len(name)))
	out = append(out, name...)
	return append(out, data...)
}

// Unpack reverses Pack, rejecting anything malformed.
func Unpack(b []byte) (name string, data []byte, err error) {
	if len(b) < len(magic)+2 || string(b[:len(magic)]) != magic {
		return "", nil, errors.New("not a Lumen Drop QR container")
	}
	n := int(binary.BigEndian.Uint16(b[len(magic):]))
	rest := b[len(magic)+2:]
	if n > maxName || n > len(rest) {
		return "", nil, errors.New("container name length out of range")
	}
	return string(rest[:n]), rest[n:], nil
}

// Sender holds every QR frame (as text) for one file.
type Sender struct {
	frames []string
}

// NewSender splits a file into txqr frames of chunkLen bytes each.
func NewSender(name string, data []byte, chunkLen int) (*Sender, error) {
	if len(data) > MaxFileSize {
		return nil, fmt.Errorf("file is %d bytes; QR mode takes up to %d", len(data), MaxFileSize)
	}
	if chunkLen < MinChunk || chunkLen > MaxChunk {
		return nil, fmt.Errorf("chunk length %d out of range", chunkLen)
	}
	frames, err := txqr.NewEncoder(chunkLen).Encode(base64.StdEncoding.EncodeToString(Pack(name, data)))
	if err != nil {
		return nil, err
	}
	return &Sender{frames: frames}, nil
}

// Len is the number of distinct frames; the sender plays them in a loop.
func (s *Sender) Len() int { return len(s.frames) }

// Frame returns frame i's text.
func (s *Sender) Frame(i int) string { return s.frames[i] }

// Matrix renders text as a QR code (error correction M, no quiet zone): the side length in
// modules and the modules row by row, 1 = dark.
func Matrix(text string) (size int, bits []byte, err error) {
	q, err := qrcode.New(text, qrcode.Medium)
	if err != nil {
		return 0, nil, err
	}
	q.DisableBorder = true
	bm := q.Bitmap()
	size = len(bm)
	bits = make([]byte, size*size)
	for y, row := range bm {
		for x, dark := range row {
			if dark {
				bits[y*size+x] = 1
			}
		}
	}
	return size, bits, nil
}

// Scan finds a QR code in a luminance image (e.g. the Y plane of a camera frame) and
// returns its content byte for byte.
func Scan(lum []byte, width, height int) (string, error) {
	return scan(lum, width, height, tryHarder)
}

var tryHarder = false

func scan(lum []byte, width, height int, harder bool) (string, error) {
	if width <= 0 || height <= 0 || len(lum) < width*height {
		return "", errors.New("luminance buffer smaller than its dimensions")
	}
	src, err := gozxing.NewPlanarYUVLuminanceSource(lum, width, height, 0, 0, width, height, false)
	if err != nil {
		return "", err
	}
	// Frames carry raw bytes (XORed fountain blocks): read them as ISO-8859-1, which maps
	// each byte to itself, instead of letting the reader guess a text encoding.
	hints := map[gozxing.DecodeHintType]interface{}{gozxing.DecodeHintType_CHARACTER_SET: "ISO-8859-1"}
	if harder {
		hints[gozxing.DecodeHintType_TRY_HARDER] = true
	}
	// The local (hybrid) binarizer suits uneven light; the global one survives noise inside
	// large modules that the local one splits into speckle. Try both.
	var last error
	for _, binarizer := range []func(gozxing.LuminanceSource) gozxing.Binarizer{gozxing.NewHybridBinarizer, gozxing.NewGlobalHistgramBinarizer} {
		bmp, err := gozxing.NewBinaryBitmap(binarizer(src))
		if err != nil {
			return "", err
		}
		res, err := zqrcode.NewQRCodeReader().Decode(bmp, hints)
		if err == nil {
			return latin1ToBytes(res.GetText()), nil
		}
		last = err
	}
	return "", last
}

// latin1ToBytes turns text decoded as ISO-8859-1 (one rune per byte) back into those bytes.
func latin1ToBytes(s string) string {
	b := make([]byte, 0, len(s))
	for _, r := range s {
		b = append(b, byte(r))
	}
	return string(b)
}

// Status reports a receiver's progress.
type Status struct {
	Progress float64 // 0..1; exactly 1 only when the file is complete
	Blocks   int     // distinct fountain blocks seen
	Chunks   int     // blocks the file is split into
	Total    int     // encoded length being received, in bytes
	Done     bool
}

// Receiver collects frames until the file can be rebuilt.
type Receiver struct {
	dec      *txqr.Decoder
	chunkLen int
	total    int
	chunks   int
	blocks   map[int64]bool
	name     string
	data     []byte
	done     bool
}

// NewReceiver returns an empty receiver.
func NewReceiver() *Receiver { return &Receiver{} }

var header = regexp.MustCompile(`^(\d{1,9})/(\d{1,5})/(\d{1,9})\|`)

// Feed takes one scanned frame. Frames from a different transfer (another size or chunk
// length) restart the receiver; anything malformed is rejected without changing state.
func (r *Receiver) Feed(text string) (st Status, err error) {
	defer func() {
		if p := recover(); p != nil {
			r.Reset()
			err = fmt.Errorf("decoder failed: %v", p)
		}
	}()
	m := header.FindStringSubmatch(text)
	if m == nil {
		return r.status(), errors.New("not a txqr frame")
	}
	code, _ := strconv.ParseInt(m[1], 10, 64)
	chunkLen, _ := strconv.Atoi(m[2])
	total, _ := strconv.Atoi(m[3])
	payload := text[len(m[0]):]
	switch {
	case chunkLen < MinChunk || chunkLen > MaxChunk:
		return r.status(), fmt.Errorf("chunk length %d out of range", chunkLen)
	case total < 1 || total > maxEncoded:
		return r.status(), fmt.Errorf("size %d out of range", total)
	case len(payload) == 0 || len(payload) > chunkLen:
		return r.status(), errors.New("payload length doesn't match the header")
	}
	if r.dec == nil || chunkLen != r.chunkLen || total != r.total {
		r.start(chunkLen, total)
	}
	if r.done {
		return r.status(), nil
	}
	r.blocks[code] = true
	if err := r.dec.Decode(text); err != nil {
		return r.status(), err
	}
	if r.dec.IsCompleted() {
		raw, err := base64.StdEncoding.DecodeString(string(r.dec.DataBytes()))
		if err == nil {
			r.name, r.data, err = Unpack(raw)
		}
		if err != nil {
			r.Reset()
			return r.status(), fmt.Errorf("rebuilt data is invalid: %v", err)
		}
		r.done = true
	}
	return r.status(), nil
}

func (r *Receiver) start(chunkLen, total int) {
	r.Reset()
	r.dec = txqr.NewDecoder()
	r.chunkLen, r.total = chunkLen, total
	r.chunks = (total + chunkLen - 1) / chunkLen
}

func (r *Receiver) status() Status {
	st := Status{Blocks: len(r.blocks), Chunks: r.chunks, Total: r.total, Done: r.done}
	switch {
	case r.done:
		st.Progress = 1
	case r.chunks > 0:
		// Fountain decoding needs a few more blocks than chunks; never claim 100% early.
		st.Progress = min(0.99, float64(len(r.blocks))/float64(r.chunks))
	}
	return st
}

// Result returns the rebuilt file once Feed has reported Done.
func (r *Receiver) Result() (name string, data []byte, ok bool) {
	return r.name, r.data, r.done
}

// Reset forgets everything received.
func (r *Receiver) Reset() {
	*r = Receiver{blocks: map[int64]bool{}}
}

package cloudcrypto

import (
	"crypto/sha256"
	"crypto/subtle"
	"errors"
	"math/big"
)

// SRP-6a (RFC 5054 §2.5-2.6), the Go port of cryptocore/src/srp.rs.
//
//	N  = RFC 5054 Appendix A 2048-bit safe prime (256 bytes, big-endian)
//	g  = 2
//	H  = SHA-256, K = H(PAD(S))
//	PAD(x) = left zero pad to N's byte length (256)
//	x = big-endian reading of the 32-byte derive_srp_x output (no mod N)
//
// Anchored by cryptocore srp_register_verifier_vector and
// srp_handshake_fixed_ephemeral_vector.

// nByteLen is N's byte length (2048-bit). All PAD targets this.
const nByteLen = 256

// nBytes is N — a direct byte-for-byte copy of cryptocore srp::N_BYTES. Any
// drift here changes the group; the verifier KAT catches it immediately.
var nBytes = [nByteLen]byte{
	0xAC, 0x6B, 0xDB, 0x41, 0x32, 0x4A, 0x9A, 0x9B, 0xF1, 0x66, 0xDE, 0x5E, 0x13, 0x89, 0x58, 0x2F,
	0xAF, 0x72, 0xB6, 0x65, 0x19, 0x87, 0xEE, 0x07, 0xFC, 0x31, 0x92, 0x94, 0x3D, 0xB5, 0x60, 0x50,
	0xA3, 0x73, 0x29, 0xCB, 0xB4, 0xA0, 0x99, 0xED, 0x81, 0x93, 0xE0, 0x75, 0x77, 0x67, 0xA1, 0x3D,
	0xD5, 0x23, 0x12, 0xAB, 0x4B, 0x03, 0x31, 0x0D, 0xCD, 0x7F, 0x48, 0xA9, 0xDA, 0x04, 0xFD, 0x50,
	0xE8, 0x08, 0x39, 0x69, 0xED, 0xB7, 0x67, 0xB0, 0xCF, 0x60, 0x95, 0x17, 0x9A, 0x16, 0x3A, 0xB3,
	0x66, 0x1A, 0x05, 0xFB, 0xD5, 0xFA, 0xAA, 0xE8, 0x29, 0x18, 0xA9, 0x96, 0x2F, 0x0B, 0x93, 0xB8,
	0x55, 0xF9, 0x79, 0x93, 0xEC, 0x97, 0x5E, 0xEA, 0xA8, 0x0D, 0x74, 0x0A, 0xDB, 0xF4, 0xFF, 0x74,
	0x73, 0x59, 0xD0, 0x41, 0xD5, 0xC3, 0x3E, 0xA7, 0x1D, 0x28, 0x1E, 0x44, 0x6B, 0x14, 0x77, 0x3B,
	0xCA, 0x97, 0xB4, 0x3A, 0x23, 0xFB, 0x80, 0x16, 0x76, 0xBD, 0x20, 0x7A, 0x43, 0x6C, 0x64, 0x81,
	0xF1, 0xD2, 0xB9, 0x07, 0x87, 0x17, 0x46, 0x1A, 0x5B, 0x9D, 0x32, 0xE6, 0x88, 0xF8, 0x77, 0x48,
	0x54, 0x45, 0x23, 0xB5, 0x24, 0xB0, 0xD5, 0x7D, 0x5E, 0xA7, 0x7A, 0x27, 0x75, 0xD2, 0xEC, 0xFA,
	0x03, 0x2C, 0xFB, 0xDB, 0xF5, 0x2F, 0xB3, 0x78, 0x61, 0x60, 0x27, 0x90, 0x04, 0xE5, 0x7A, 0xE6,
	0xAF, 0x87, 0x4E, 0x73, 0x03, 0xCE, 0x53, 0x29, 0x9C, 0xCC, 0x04, 0x1C, 0x7B, 0xC3, 0x08, 0xD8,
	0x2A, 0x56, 0x98, 0xF3, 0xA8, 0xD0, 0xC3, 0x82, 0x71, 0xAE, 0x35, 0xF8, 0xE9, 0xDB, 0xFB, 0xB6,
	0x94, 0xB5, 0xC8, 0x03, 0xD8, 0x9F, 0x7A, 0xE4, 0x35, 0xDE, 0x23, 0x6D, 0x52, 0x5F, 0x54, 0x75,
	0x9B, 0x65, 0xE3, 0x72, 0xFC, 0xD6, 0x8E, 0xF2, 0x0F, 0xA7, 0x11, 0x1F, 0x9E, 0x4A, 0xFF, 0x73,
}

// ErrSRPBAbort / ErrSRPAAbort mirror RFC 5054 §2.6 forced aborts (B≡0 / A≡0 mod N).
var (
	ErrSRPBAbort = errors.New("cloudcrypto: srp B is congruent to 0 mod N")
	ErrSRPXLen   = errors.New("cloudcrypto: srp x must be 32 bytes")
)

func groupN() *big.Int { return new(big.Int).SetBytes(nBytes[:]) }
func groupG() *big.Int { return big.NewInt(2) }

// pad left-zero-pads x to N's byte length (256). x is always < N (group element).
func pad(x *big.Int) []byte {
	raw := x.Bytes()
	out := make([]byte, nByteLen)
	copy(out[nByteLen-len(raw):], raw)
	return out
}

// srpHash feeds chunks into SHA-256 in order and returns the 32-byte digest.
func srpHash(chunks ...[]byte) [32]byte {
	h := sha256.New()
	for _, c := range chunks {
		h.Write(c)
	}
	var out [32]byte
	copy(out[:], h.Sum(nil))
	return out
}

func hashToInt(d [32]byte) *big.Int { return new(big.Int).SetBytes(d[:]) }

// computeK = H(N || PAD(g)) (RFC 5054 §2.5.3). N is already 256 bytes; g padded.
func computeK(g *big.Int) *big.Int {
	d := srpHash(nBytes[:], pad(g))
	return hashToInt(d)
}

// computeU = H(PAD(A) || PAD(B)) (RFC 5054 §2.6).
func computeU(aPub, bPub *big.Int) *big.Int {
	d := srpHash(pad(aPub), pad(bPub))
	return hashToInt(d)
}

// computeM1 = H( (H(N) XOR H(PAD(g))) | H(I) | s | PAD(A) | PAD(B) | K ).
func computeM1(g *big.Int, identity, salt []byte, aPub, bPub *big.Int, sessionKey [32]byte) [32]byte {
	hn := srpHash(nBytes[:])
	hg := srpHash(pad(g))
	var hnXorHg [32]byte
	for i := 0; i < 32; i++ {
		hnXorHg[i] = hn[i] ^ hg[i]
	}
	hi := srpHash(identity)
	return srpHash(hnXorHg[:], hi[:], salt, pad(aPub), pad(bPub), sessionKey[:])
}

// computeM2 = H( PAD(A) | M1 | K ) (RFC 5054 §2.6 server confirm).
func computeM2(aPub *big.Int, m1 [32]byte, sessionKey [32]byte) [32]byte {
	return srpHash(pad(aPub), m1[:], sessionKey[:])
}

// SrpRegistration is the registration output: salt (= derive_srp_x's salt_auth)
// and verifier v = g^x mod N (PAD to 256 bytes).
type SrpRegistration struct {
	Salt     []byte
	Verifier []byte
}

// SrpRegister computes the verifier v = g^x mod N from the 32-byte SRP-x and the
// auth salt (RFC 5054 §2.5.3). Verifier is PAD'd to 256 bytes.
func SrpRegister(xBytes, salt []byte) (SrpRegistration, error) {
	if len(xBytes) != KeySize {
		return SrpRegistration{}, ErrSRPXLen
	}
	n := groupN()
	g := groupG()
	x := new(big.Int).SetBytes(xBytes)
	v := new(big.Int).Exp(g, x, n)
	return SrpRegistration{Salt: append([]byte(nil), salt...), Verifier: pad(v)}, nil
}

// SrpClientStart is the client ephemeral: secret a (32 bytes) and A = g^a mod N
// (PAD 256). One-shot; never reuse.
type SrpClientStart struct {
	SecretA []byte // sensitive
	APub    []byte
}

// SrpClientStart generates a one-time a and A = g^a mod N (RFC 5054 §2.6).
func NewSrpClientStart() (SrpClientStart, error) {
	aBytes, a, err := randomEphemeral()
	if err != nil {
		return SrpClientStart{}, err
	}
	n := groupN()
	g := groupG()
	aPub := new(big.Int).Exp(g, a, n)
	return SrpClientStart{SecretA: aBytes, APub: pad(aPub)}, nil
}

// randomEphemeral draws a nonzero 256-bit ephemeral (< N), returning bytes + int.
func randomEphemeral() ([]byte, *big.Int, error) {
	for {
		b, err := randomBytes(KeySize)
		if err != nil {
			return nil, nil, err
		}
		v := new(big.Int).SetBytes(b)
		if v.Sign() != 0 {
			return b, v, nil
		}
	}
}

// SrpClientProof is the client handshake output: M1 (to server) and the shared
// session key K = H(S).
type SrpClientProof struct {
	M1         [32]byte
	SessionKey [32]byte // sensitive
}

// SrpClientFinish computes S / K / M1 (RFC 5054 §2.6):
//
//	S = (B - k*(g^x mod N))^(a + u*x) mod N   (subtraction taken positive mod N)
//	K = H(PAD(S))
//
// identity is the lowercased-email bytes (must match registration / server).
func SrpClientFinish(aSecret, aPub, bPub, xBytes, salt, identity []byte) (SrpClientProof, error) {
	if len(xBytes) != KeySize {
		return SrpClientProof{}, ErrSRPXLen
	}
	n := groupN()
	g := groupG()

	aPriv := new(big.Int).SetBytes(aSecret)
	a := new(big.Int).SetBytes(aPub)
	b := new(big.Int).SetBytes(bPub)

	// RFC 5054 §2.6: abort if B % N == 0.
	if new(big.Int).Mod(b, n).Sign() == 0 {
		return SrpClientProof{}, ErrSRPBAbort
	}

	x := new(big.Int).SetBytes(xBytes)
	k := computeK(g)
	u := computeU(a, b)

	gx := new(big.Int).Exp(g, x, n) // g^x mod N
	kgx := new(big.Int).Mod(new(big.Int).Mul(k, gx), n)
	// base = ((B mod N) + N - kgx) mod N  (modular subtraction kept positive)
	base := new(big.Int).Mod(b, n)
	base.Add(base, n)
	base.Sub(base, kgx)
	base.Mod(base, n)
	// exp = a + u*x
	exp := new(big.Int).Add(aPriv, new(big.Int).Mul(u, x))
	s := new(big.Int).Exp(base, exp, n)

	sessionKey := srpHash(pad(s))
	m1 := computeM1(g, identity, salt, a, b, sessionKey)
	return SrpClientProof{M1: m1, SessionKey: sessionKey}, nil
}

// VerifyServerM2 checks the server M2 = H(PAD(A) | M1 | K) in constant time.
// aPub is this handshake's A bytes (SrpClientStart.APub).
func (p SrpClientProof) VerifyServerM2(aPub, serverM2 []byte) bool {
	a := new(big.Int).SetBytes(aPub)
	expected := computeM2(a, p.M1, p.SessionKey)
	return subtle.ConstantTimeCompare(expected[:], serverM2) == 1
}

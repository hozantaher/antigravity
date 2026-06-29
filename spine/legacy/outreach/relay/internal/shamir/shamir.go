package shamir

import (
	"crypto/rand"
	"errors"
)

// Shamir Secret Sharing over GF(256).
// Splits a secret into N shares where any K shares can reconstruct.
// Uses polynomial interpolation over the Galois Field GF(2^8).
//
// Security property: K-1 shares reveal zero information about the secret.

var (
	ErrInvalidK    = errors.New("K must be >= 2")
	ErrInvalidN    = errors.New("N must be >= K")
	ErrTooFewN     = errors.New("N must be <= 255")
	ErrTooFew      = errors.New("not enough shares to reconstruct")
	ErrEmptySecret = errors.New("secret is empty")
)

// Share represents one piece of a split secret.
type Share struct {
	X    byte   // evaluation point (1-255, never 0)
	Data []byte // share data (same length as secret)
}

// Split divides secret into N shares, any K of which can reconstruct.
func Split(secret []byte, k, n int) ([]Share, error) {
	if len(secret) == 0 {
		return nil, ErrEmptySecret
	}
	if k < 2 {
		return nil, ErrInvalidK
	}
	if n < k {
		return nil, ErrInvalidN
	}
	if n > 255 {
		return nil, ErrTooFewN
	}

	shares := make([]Share, n)
	for i := range shares {
		shares[i] = Share{
			X:    byte(i + 1), // x = 1..N (never 0)
			Data: make([]byte, len(secret)),
		}
	}

	// For each byte of the secret, create a random polynomial of degree K-1
	// where the constant term is the secret byte.
	coeffs := make([]byte, k)
	for byteIdx := 0; byteIdx < len(secret); byteIdx++ {
		coeffs[0] = secret[byteIdx]

		// Random coefficients for terms 1..K-1
		if _, err := rand.Read(coeffs[1:]); err != nil {
			return nil, err
		}

		// Evaluate polynomial at each x point
		for i := range shares {
			shares[i].Data[byteIdx] = evalPolynomial(coeffs, shares[i].X)
		}
	}

	return shares, nil
}

// Combine reconstructs the secret from K or more shares.
func Combine(shares []Share, k int) ([]byte, error) {
	if len(shares) < k {
		return nil, ErrTooFew
	}

	// Use first K shares
	used := shares[:k]
	secretLen := len(used[0].Data)

	secret := make([]byte, secretLen)
	for byteIdx := 0; byteIdx < secretLen; byteIdx++ {
		// Lagrange interpolation at x=0
		var result byte
		for i := 0; i < k; i++ {
			xi := used[i].X
			yi := used[i].Data[byteIdx]

			// Compute Lagrange basis polynomial at x=0
			var num, den byte = 1, 1
			for j := 0; j < k; j++ {
				if i == j {
					continue
				}
				xj := used[j].X
				num = gfMul(num, xj)          // num *= (0 - xj) = xj in GF(256)
				den = gfMul(den, gfAdd(xi, xj)) // den *= (xi - xj)
			}

			// basis = num / den
			basis := gfMul(num, gfInv(den))
			result = gfAdd(result, gfMul(yi, basis))
		}
		secret[byteIdx] = result
	}

	return secret, nil
}

// GF(256) arithmetic using AES irreducible polynomial x^8 + x^4 + x^3 + x + 1

func gfAdd(a, b byte) byte { return a ^ b }

func gfMul(a, b byte) byte {
	if a == 0 || b == 0 {
		return 0
	}
	return expTable[(int(logTable[a])+int(logTable[b]))%255]
}

func gfInv(a byte) byte {
	if a == 0 {
		return 0
	}
	return expTable[255-int(logTable[a])]
}

func evalPolynomial(coeffs []byte, x byte) byte {
	// Horner's method: result = c[n-1]*x + c[n-2], etc.
	result := coeffs[len(coeffs)-1]
	for i := len(coeffs) - 2; i >= 0; i-- {
		result = gfAdd(gfMul(result, x), coeffs[i])
	}
	return result
}

// Precomputed log/exp tables for GF(256) with generator 3
var logTable, expTable [256]byte

func init() {
	var val byte = 1
	for i := 0; i < 255; i++ {
		expTable[i] = val
		logTable[val] = byte(i)
		// Multiply by generator (3)
		val2 := int(val) << 1
		if val2 >= 256 {
			val2 ^= 0x11b // AES polynomial
		}
		val = byte(val2) ^ val // val * 3 = val * 2 + val
	}
	expTable[255] = expTable[0]
}

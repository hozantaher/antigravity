package auth

import (
	"net/http/httptest"
	"testing"

	"privacy-gateway/internal/model"
)

func TestAuthenticateAcceptsBearerToken(t *testing.T) {
	expected := model.Actor{ID: "user-1", TenantID: "tenant-1"}
	authenticator := NewStaticTokenAuthenticator(map[string]model.Actor{
		"token-1": expected,
	})

	request := httptest.NewRequest("GET", "/v1/aliases", nil)
	request.Header.Set("Authorization", "Bearer token-1")

	actor, err := authenticator.Authenticate(request)
	if err != nil {
		t.Fatalf("Authenticate() error = %v", err)
	}
	if actor != expected {
		t.Fatalf("expected actor %+v, got %+v", expected, actor)
	}
}

func TestAuthenticateRejectsInvalidAuthorization(t *testing.T) {
	authenticator := NewStaticTokenAuthenticator(map[string]model.Actor{
		"token-1": {ID: "user-1"},
	})

	testCases := []struct {
		name   string
		header string
	}{
		{name: "missing header"},
		{name: "wrong scheme", header: "Basic token-1"},
		{name: "unknown token", header: "Bearer token-2"},
	}

	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			request := httptest.NewRequest("GET", "/v1/aliases", nil)
			if testCase.header != "" {
				request.Header.Set("Authorization", testCase.header)
			}

			if _, err := authenticator.Authenticate(request); err != ErrUnauthorized {
				t.Fatalf("expected ErrUnauthorized, got %v", err)
			}
		})
	}
}

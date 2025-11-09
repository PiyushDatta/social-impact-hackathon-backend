#!/usr/bin/env python3
"""
Google Authentication Testing Script with Real OAuth Flow
Tests the /auth/google endpoint using actual Google sign-in
Uses google-auth-oauthlib for proper OAuth flow
"""

import requests
import json
import sys
from typing import Optional, Dict, Any


# Colors for terminal output
class Colors:
    GREEN = "\033[92m"
    RED = "\033[91m"
    YELLOW = "\033[93m"
    BLUE = "\033[94m"
    CYAN = "\033[96m"
    MAGENTA = "\033[95m"
    RESET = "\033[0m"
    BOLD = "\033[1m"


def print_header(text: str):
    """Print a formatted header"""
    print(f"\n{Colors.BOLD}{Colors.CYAN}{'=' * 70}{Colors.RESET}")
    print(f"{Colors.BOLD}{Colors.CYAN}{text.center(70)}{Colors.RESET}")
    print(f"{Colors.BOLD}{Colors.CYAN}{'=' * 70}{Colors.RESET}\n")


def print_success(text: str):
    """Print success message"""
    print(f"{Colors.GREEN}✓ {text}{Colors.RESET}")


def print_error(text: str):
    """Print error message"""
    print(f"{Colors.RED}✗ {text}{Colors.RESET}")


def print_info(text: str):
    """Print info message"""
    print(f"{Colors.BLUE}ℹ {text}{Colors.RESET}")


def print_warning(text: str):
    """Print warning message"""
    print(f"{Colors.YELLOW}⚠ {text}{Colors.RESET}")


def print_response(response: requests.Response):
    """Pretty print HTTP response"""
    print(f"\n{Colors.BOLD}Response:{Colors.RESET}")
    print(f"  Status Code: {response.status_code}")
    try:
        print(f"  Body: {json.dumps(response.json(), indent=2)}")
    except:
        print(f"  Body: {response.text[:500]}")


def get_google_id_token_interactive(
    client_id: str, client_secret: str
) -> Optional[str]:
    """
    Get Google ID token using OAuth2 flow with google-auth-oauthlib
    """
    try:
        from google_auth_oauthlib.flow import InstalledAppFlow
    except ImportError:
        print_error("Required library not found!")
        print_info("Install it with: pip install google-auth-oauthlib")
        return None

    print_header("Google Sign-In via OAuth2")
    print_info("Opening browser for Google sign-in...")

    # Create client config
    client_config = {
        "installed": {
            "client_id": client_id,
            "client_secret": client_secret,
            "auth_uri": "https://accounts.google.com/o/oauth2/auth",
            "token_uri": "https://oauth2.googleapis.com/token",
            "redirect_uris": ["http://localhost:8181/", "urn:ietf:wg:oauth:2.0:oob"],
        }
    }

    # Scopes that will give us an id_token
    scopes = [
        "openid",
        "https://www.googleapis.com/auth/userinfo.email",
        "https://www.googleapis.com/auth/userinfo.profile",
    ]

    try:
        # Create the flow
        flow = InstalledAppFlow.from_client_config(
            client_config, scopes=scopes, redirect_uri="http://localhost:8181/"
        )

        # Run local server to get credentials
        print_info("Starting local server on port 8181...")
        print_info("Your browser will open for Google sign-in")
        print_info("Press Ctrl+C to cancel at any time")

        credentials = flow.run_local_server(port=8181, open_browser=True)

        # Get the ID token
        id_token = credentials.id_token

        if id_token:
            print_success("Successfully obtained ID token!")
            print_info(f"Token preview: {id_token[:50]}...")
            return id_token
        else:
            print_error("No ID token in credentials")
            return None

    except KeyboardInterrupt:
        print_info("\n\nCancelled by user")
        return None
    except Exception as e:
        print_error(f"OAuth flow failed: {str(e)}")
        return None


def test_auth_missing_token(base_url: str) -> bool:
    """Test auth endpoint with missing token"""
    print_header("Test 1: Missing idToken")
    print_info("Testing /auth/google with no idToken...")

    try:
        response = requests.post(f"{base_url}/auth/google", json={}, timeout=10)
        print_response(response)

        if response.status_code == 400:
            data = response.json()
            if "error" in data and "Missing idToken" in data["error"]:
                print_success("Correctly rejected missing token")
                return True
            else:
                print_error("Wrong error message")
                return False
        else:
            print_error(f"Expected 400, got {response.status_code}")
            return False

    except Exception as e:
        print_error(f"Error: {str(e)}")
        return False


def test_auth_invalid_token(base_url: str) -> bool:
    """Test auth endpoint with invalid token"""
    print_header("Test 2: Invalid idToken")
    print_info("Testing /auth/google with fake token...")

    try:
        response = requests.post(
            f"{base_url}/auth/google",
            json={"idToken": "fake.invalid.token"},
            timeout=10,
        )
        print_response(response)

        if response.status_code in [401, 500]:
            print_success("Correctly rejected invalid token")
            return True
        else:
            print_error(f"Expected 401 or 500, got {response.status_code}")
            return False

    except Exception as e:
        print_error(f"Error: {str(e)}")
        return False


def test_auth_valid_token(base_url: str, id_token: str) -> Optional[Dict[str, Any]]:
    """Test auth endpoint with valid Google token"""
    print_header("Test 3: Valid Google idToken")
    print_info("Testing /auth/google with real token...")
    full_url = f"{base_url}/auth/google"
    print(f"Sending token to full url ({full_url}), {id_token[:40]}")
    try:
        response = requests.post(
            full_url,
            json={"idToken": id_token},   # ✅ correct
            timeout=10,
        )
        print_response(response)

        if response.status_code == 200:
            data = response.json()

            # Validate response structure
            required_fields = ["success", "isNewUser", "profile"]
            missing_fields = [f for f in required_fields if f not in data]

            if missing_fields:
                print_error(f"Missing fields: {missing_fields}")
                return None

            profile = data.get("profile", {})
            print_success("Authentication successful!")
            print_info(f"User ID: {profile.get('uid')}")
            print_info(f"Email: {profile.get('email')}")
            print_info(f"Name: {profile.get('name')}")
            print_info(f"Is New User: {data.get('isNewUser')}")

            return data
        else:
            print_error(f"Authentication failed: {response.status_code}")
            return None

    except Exception as e:
        print_error(f"Error: {str(e)}")
        return None


def main():
    """Main entry point"""
    import argparse

    parser = argparse.ArgumentParser(
        description="Test Google authentication endpoint with real OAuth",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Test with interactive Google sign-in
  python test_auth.py --client-id YOUR_ID --client-secret YOUR_SECRET
  
  # Test with custom server URL
  python test_auth.py --url https://your-api.com --client-id YOUR_ID --client-secret YOUR_SECRET
  
  # Skip interactive sign-in (validation tests only)
  python test_auth.py --skip-signin

Setup:
  1. Install: pip install google-auth-oauthlib requests
  2. Get your credentials from Google Cloud Console:
     - Go to APIs & Services → Credentials
     - Create OAuth 2.0 Client ID (Desktop app)
     - Add http://localhost:8181/ as authorized redirect URI (note the trailing slash!)
  3. Run with --client-id and --client-secret
        """,
    )
    parser.add_argument(
        "--url",
        default="http://localhost:8080",
        help="Base URL of your API (default: http://localhost:8080)",
    )
    parser.add_argument(
        "--client-id",
        help="Google OAuth Client ID (required for interactive sign-in)",
        default=None,
    )
    parser.add_argument(
        "--client-secret",
        help="Google OAuth Client Secret (required for interactive sign-in)",
        default=None,
    )
    parser.add_argument(
        "--skip-signin",
        action="store_true",
        help="Skip interactive sign-in (validation tests only)",
    )

    args = parser.parse_args()
    base_url = args.url.rstrip("/")

    print(f"\n{Colors.BOLD}{Colors.BLUE}")
    print("╔═══════════════════════════════════════════════════════════════════╗")
    print("║              Google Authentication Test Suite                    ║")
    print("╚═══════════════════════════════════════════════════════════════════╝")
    print(f"{Colors.RESET}")

    print_info(f"Base URL: {base_url}")

    # Test 1: Missing token
    test_auth_missing_token(base_url)

    # Test 2: Invalid token
    test_auth_invalid_token(base_url)

    # Test 3: Valid token (interactive)
    if not args.skip_signin:
        if not args.client_id or not args.client_secret:
            print_warning("\nMissing --client-id or --client-secret")
            print_info("To test with real Google sign-in, you need both:")
            print_info(
                "  python test_auth.py --client-id YOUR_ID --client-secret YOUR_SECRET"
            )
            print_info(
                "\nGet these from: https://console.cloud.google.com/apis/credentials"
            )
            print_header("Basic Validation Tests Passed!")
            sys.exit(0)

        print_info(f"Using Client ID: {args.client_id[:30]}...")

        id_token = get_google_id_token_interactive(args.client_id, args.client_secret)

        if id_token:
            result = test_auth_valid_token(base_url, id_token)
            if result:
                print_header("All Tests Passed! ✓")
                sys.exit(0)
            else:
                print_error("Valid token test failed")
                sys.exit(1)
        else:
            print_error("Failed to obtain Google ID token")
            sys.exit(1)
    else:
        print_warning("\nSkipping interactive sign-in test (--skip-signin)")
        print_header("Basic Validation Tests Passed!")
        sys.exit(0)


if __name__ == "__main__":
    main()

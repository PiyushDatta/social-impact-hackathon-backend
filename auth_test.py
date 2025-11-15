import os
import time
import requests
import webbrowser

# Configuration
BASE_URL = os.getenv(
    "BASE_URL", "https://social-impact-hackathon-backend-719737115197.us-west2.run.app"
)

GREEN = "\033[92m"
RED = "\033[91m"
CYAN = "\033[96m"
YELLOW = "\033[93m"
RESET = "\033[0m"


def print_header(t):
    print(f"\n{CYAN}{'='*60}\n{t}\n{'='*60}{RESET}")


def print_success(msg):
    print(f"{GREEN}✓ {msg}{RESET}")


def print_error(msg):
    print(f"{RED}✗ {msg}{RESET}")


def print_info(msg):
    print(f"{CYAN}{msg}{RESET}")


# ───────────────────────────────
# Backend Health
# ───────────────────────────────
def test_backend_ready():
    print_header("1. Checking backend health...")
    try:
        r = requests.get(f"{BASE_URL}/health", timeout=5)
        if r.status_code == 200:
            print_success("Backend OK")
            return True
        print_error(f"Unexpected status: {r.status_code}")
        return False
    except Exception as e:
        print_error(str(e))
        return False


# ───────────────────────────────
# Fetch OAuth URL
# ───────────────────────────────
def get_oauth_url():
    print_header("2. Getting OAuth URL...")
    try:
        r = requests.get(f"{BASE_URL}/auth/google/url", timeout=10)
        data = r.json()
        url = data.get("authUrl")
        if not url:
            print_error("Missing authUrl")
            return None
        print_success("Got login URL")
        return url
    except Exception as e:
        print_error(str(e))
        return None


# ───────────────────────────────
# Open Browser for Login
# ───────────────────────────────
def open_browser(oauth_url):
    print_header("3. Opening browser for login...")
    print_info("Your existing browser will open.")
    webbrowser.open(oauth_url)
    print_info(f"{YELLOW}Complete Google login normally.{RESET}")
    print_info("The backend will store your session automatically.")
    print_info("Waiting for backend to detect authentication...")


# ───────────────────────────────
# Poll /auth/get-auth
# ───────────────────────────────
def poll_get_auth():
    print_header("4. Polling /auth/get-auth...")

    for attempt in range(30):  # 30 seconds
        try:
            r = requests.get(f"{BASE_URL}/auth/get-auth", timeout=5)
            data = r.json()

            if data.get("ready"):
                print_success("Authentication detected (via get-auth)")
                return data["data"]

            print_info(f"Attempt {attempt+1}/30: not ready yet...")
            time.sleep(1)

        except Exception as e:
            print_error(str(e))
            time.sleep(1)

    print_error("Timeout waiting for /auth/get-auth")
    return None


# ───────────────────────────────
# Poll /auth/me
# ───────────────────────────────
def poll_auth_me():
    print_header("5. Polling /auth/me...")

    for attempt in range(30):
        try:
            r = requests.get(f"{BASE_URL}/auth/me", timeout=5)

            if r.status_code == 200:
                data = r.json()
                if data.get("authenticated"):
                    print_success("Authentication detected (via /auth/me)")
                    return data["user"]

            print_info(f"Attempt {attempt+1}/30: still not authenticated...")
            time.sleep(1)

        except Exception as e:
            print_error(str(e))
            time.sleep(1)

    print_error("Timeout waiting for /auth/me")
    return None


# ───────────────────────────────
# MAIN
# ───────────────────────────────
def main():
    print_header("AUTOMATED GOOGLE OAUTH TEST (Simplified)")

    if not test_backend_ready():
        return

    oauth_url = get_oauth_url()
    if not oauth_url:
        return

    open_browser(oauth_url)

    # Try either method (your backend supports both)
    auth_data = poll_get_auth()

    if not auth_data:
        print_info("Trying fallback using /auth/me ...")
        auth_data = poll_auth_me()

    if not auth_data:
        print_error("Could not verify authentication.")
        return

    print_success("User authenticated!")
    print_info(f"User Data: {auth_data}")


if __name__ == "__main__":
    main()

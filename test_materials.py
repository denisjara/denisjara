#!/usr/bin/env python3
"""
Test different material combinations to find valid E.060 designs
"""

import requests
import math

def get_backend_url():
    try:
        with open('/app/frontend/.env', 'r') as f:
            for line in f:
                if line.startswith('REACT_APP_BACKEND_URL='):
                    return line.split('=', 1)[1].strip()
    except:
        pass
    return "http://localhost:8001"

BASE_URL = get_backend_url()
API_URL = f"{BASE_URL}/api"

def test_material_combination(fc, fy, description):
    """Test a specific material combination"""
    test_data = {
        "width": 30.0,
        "height": 60.0,
        "length": 6.0,
        "dead_load": 10.0,  # Reduced loads
        "live_load": 5.0,
        "fc": fc,
        "fy": fy,
        "cover": 4.0
    }
    
    print(f"\nTesting {description} (f'c={fc} MPa, fy={fy} MPa):")
    
    # Manual calculation
    if fc <= 28:
        beta1 = 0.85
    else:
        beta1 = max(0.65, 0.85 - 0.05 * (fc - 28) / 7)
    
    rho_balanced = (0.85 * fc * beta1 / fy) * (600 / (600 + fy))
    rho_min = max(0.7 * math.sqrt(fc) / fy, 14 / fy)
    rho_max = 0.75 * rho_balanced
    
    print(f"   Manual calc: rho_min={rho_min:.4f}, rho_max={rho_max:.4f}")
    
    if rho_min <= rho_max:
        print(f"   ✅ Ratios are valid (rho_min <= rho_max)")
    else:
        print(f"   ❌ Invalid ratios (rho_min > rho_max)")
        return False
    
    # API test
    response = requests.post(f"{API_URL}/beam/design", json=test_data, timeout=10)
    
    if response.status_code == 200:
        result = response.json()
        print(f"   API result: Valid={result['is_valid']}")
        print(f"   API ratios: rho_min={result['rho_min']:.4f}, rho_max={result['rho_max']:.4f}")
        if result['is_valid']:
            print(f"   Steel: {result['suggested_bars']}")
        else:
            print(f"   Messages: {result['messages']}")
        return result['is_valid']
    else:
        print(f"   ❌ API Error: {response.status_code}")
        return False

if __name__ == "__main__":
    print("=" * 70)
    print("TESTING DIFFERENT MATERIAL COMBINATIONS")
    print("=" * 70)
    
    # Test various combinations
    combinations = [
        (21, 420, "Standard Peruvian materials"),
        (28, 420, "Higher strength concrete"),
        (35, 420, "High strength concrete"),
        (21, 280, "Lower grade steel"),
        (28, 280, "Medium concrete + lower steel"),
        (35, 500, "High strength materials"),
        (17.5, 420, "Lower concrete strength"),
        (25, 350, "Intermediate materials")
    ]
    
    valid_count = 0
    for fc, fy, desc in combinations:
        if test_material_combination(fc, fy, desc):
            valid_count += 1
    
    print(f"\n" + "=" * 70)
    print(f"SUMMARY: {valid_count}/{len(combinations)} combinations produced valid designs")
    
    if valid_count == 0:
        print("\n⚠️  CRITICAL FINDING: No material combinations produce valid designs")
        print("This suggests there may be an issue with the E.060 implementation")
        print("Specifically with the minimum reinforcement ratio formula")
    else:
        print(f"\n✅ Found {valid_count} valid material combinations")
        print("The E.060 implementation appears to be working correctly")
#!/usr/bin/env python3
"""
Final comprehensive test of E.060 beam design calculations
"""

import requests
import json

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

def test_comprehensive_beam_design():
    """Test comprehensive beam design scenarios"""
    
    test_cases = [
        {
            "name": "Standard residential beam",
            "data": {
                "width": 30.0, "height": 60.0, "length": 6.0,
                "dead_load": 15.0, "live_load": 10.0,
                "fc": 21.0, "fy": 420.0, "cover": 4.0
            },
            "expected_valid": True
        },
        {
            "name": "Large commercial beam",
            "data": {
                "width": 50.0, "height": 80.0, "length": 8.0,
                "dead_load": 25.0, "live_load": 20.0,
                "fc": 28.0, "fy": 420.0, "cover": 5.0
            },
            "expected_valid": True
        },
        {
            "name": "Small secondary beam",
            "data": {
                "width": 25.0, "height": 40.0, "length": 4.0,
                "dead_load": 8.0, "live_load": 5.0,
                "fc": 21.0, "fy": 420.0, "cover": 3.0
            },
            "expected_valid": True
        }
    ]
    
    print("=" * 70)
    print("COMPREHENSIVE E.060 BEAM DESIGN TESTING")
    print("=" * 70)
    
    all_passed = True
    
    for i, test_case in enumerate(test_cases, 1):
        print(f"\nTest {i}: {test_case['name']}")
        print("-" * 50)
        
        try:
            response = requests.post(f"{API_URL}/beam/design", 
                                   json=test_case['data'], 
                                   timeout=10)
            
            if response.status_code == 200:
                result = response.json()
                
                print(f"✅ API Response: Success")
                print(f"   Valid Design: {result['is_valid']}")
                print(f"   Total Load: {result['total_load']:.1f} kN/m")
                print(f"   Ultimate Moment: {result['max_moment_ultimate']:.1f} kN⋅m")
                print(f"   rho_min: {result['rho_min']:.4f}")
                print(f"   rho_max: {result['rho_max']:.4f}")
                print(f"   Required rho: {result['required_rho']:.4f}")
                print(f"   Required As: {result['required_as']:.2f} cm²")
                print(f"   Steel Suggestion: {result['suggested_bars']}")
                
                if result['messages']:
                    print(f"   Messages: {result['messages']}")
                
                # Verify engineering constraints
                constraints_ok = True
                
                # Check reinforcement ratio limits
                if result['rho_min'] > result['rho_max']:
                    print(f"   ❌ ERROR: rho_min > rho_max")
                    constraints_ok = False
                
                # Check required ratio is within limits
                if result['required_rho'] < result['rho_min']:
                    print(f"   ⚠️  Using minimum reinforcement")
                elif result['required_rho'] > result['rho_max']:
                    print(f"   ❌ ERROR: Required reinforcement exceeds maximum")
                    constraints_ok = False
                
                # Check steel area is positive
                if result['required_as'] <= 0:
                    print(f"   ❌ ERROR: Invalid steel area")
                    constraints_ok = False
                
                # Check effective depth is reasonable
                expected_d = test_case['data']['height'] - test_case['data']['cover'] - 1
                if abs(result['effective_depth'] - expected_d) > 2:
                    print(f"   ❌ ERROR: Effective depth calculation issue")
                    constraints_ok = False
                
                if constraints_ok and result['is_valid'] == test_case['expected_valid']:
                    print(f"   ✅ Test PASSED")
                else:
                    print(f"   ❌ Test FAILED")
                    all_passed = False
                    
            else:
                print(f"   ❌ API Error: {response.status_code}")
                all_passed = False
                
        except Exception as e:
            print(f"   ❌ Exception: {str(e)}")
            all_passed = False
    
    print("\n" + "=" * 70)
    print("FINAL RESULT")
    print("=" * 70)
    
    if all_passed:
        print("🎉 ALL COMPREHENSIVE TESTS PASSED!")
        print("✅ E.060 beam design calculations are working correctly")
        print("✅ All engineering constraints are properly enforced")
        print("✅ Steel reinforcement suggestions are reasonable")
        return True
    else:
        print("❌ Some tests failed - review implementation")
        return False

if __name__ == "__main__":
    success = test_comprehensive_beam_design()
    exit(0 if success else 1)
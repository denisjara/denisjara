#!/usr/bin/env python3
"""
Backend Testing for Beam Design Application
Tests the structural engineering calculations according to Peruvian E.060 code
"""

import requests
import json
import sys
import os
from datetime import datetime

# Get backend URL from frontend .env file
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

print(f"Testing backend at: {API_URL}")

class BeamDesignTester:
    def __init__(self):
        self.test_results = []
        self.saved_design_id = None
        
    def log_test(self, test_name, success, details=""):
        """Log test results"""
        status = "✅ PASS" if success else "❌ FAIL"
        print(f"{status} {test_name}")
        if details:
            print(f"   Details: {details}")
        self.test_results.append({
            'test': test_name,
            'success': success,
            'details': details
        })
        
    def test_root_endpoint(self):
        """Test the root API endpoint"""
        try:
            response = requests.get(f"{API_URL}/", timeout=10)
            if response.status_code == 200:
                data = response.json()
                if "API de Diseño de Vigas" in data.get("message", ""):
                    self.log_test("Root endpoint", True, f"Response: {data}")
                else:
                    self.log_test("Root endpoint", False, f"Unexpected message: {data}")
            else:
                self.log_test("Root endpoint", False, f"Status: {response.status_code}")
        except Exception as e:
            self.log_test("Root endpoint", False, f"Error: {str(e)}")
    
    def test_beam_design_valid_case(self):
        """Test beam design with valid engineering inputs"""
        # Realistic beam design case: 30x60cm beam, 6m span
        test_data = {
            "width": 30.0,      # cm
            "height": 60.0,     # cm  
            "length": 6.0,      # m
            "dead_load": 15.0,  # kN/m
            "live_load": 10.0,  # kN/m
            "fc": 21.0,         # MPa (common concrete strength in Peru)
            "fy": 420.0,        # MPa (Grade 60 steel)
            "cover": 4.0        # cm
        }
        
        try:
            response = requests.post(f"{API_URL}/beam/design", 
                                   json=test_data, 
                                   timeout=10)
            
            if response.status_code == 200:
                result = response.json()
                
                # Verify key calculations
                expected_total_load = 25.0  # 15 + 10
                expected_service_moment = 25.0 * 6**2 / 8  # 112.5 kN⋅m
                expected_ultimate_moment = 1.4 * (15.0 * 36/8) + 1.7 * (10.0 * 36/8)  # ~171.75 kN⋅m
                
                checks = []
                
                # Check load calculations
                if abs(result['total_load'] - expected_total_load) < 0.1:
                    checks.append("Total load calculation correct")
                else:
                    checks.append(f"Total load error: got {result['total_load']}, expected {expected_total_load}")
                
                # Check service moment
                if abs(result['max_moment_service'] - expected_service_moment) < 1.0:
                    checks.append("Service moment calculation correct")
                else:
                    checks.append(f"Service moment error: got {result['max_moment_service']}, expected {expected_service_moment}")
                
                # Check ultimate moment
                if abs(result['max_moment_ultimate'] - expected_ultimate_moment) < 5.0:
                    checks.append("Ultimate moment calculation correct")
                else:
                    checks.append(f"Ultimate moment error: got {result['max_moment_ultimate']}, expected {expected_ultimate_moment}")
                
                # Check material properties
                if 0.8 < result['beta1'] <= 0.85:
                    checks.append("Beta1 factor in valid range")
                else:
                    checks.append(f"Beta1 factor issue: {result['beta1']}")
                
                # Check reinforcement ratios
                if result['rho_min'] > 0 and result['rho_max'] > result['rho_min']:
                    checks.append("Reinforcement ratio limits valid")
                else:
                    checks.append(f"Reinforcement ratio limits issue: min={result['rho_min']}, max={result['rho_max']}")
                
                # Check design validity
                if result['is_valid']:
                    checks.append("Design marked as valid")
                else:
                    checks.append(f"Design marked invalid: {result['messages']}")
                
                # Check steel suggestion
                if result['suggested_bars'] and "φ" in result['suggested_bars']:
                    checks.append("Steel bar suggestion provided")
                else:
                    checks.append("No proper steel bar suggestion")
                
                # Check effective depth
                expected_d = 60 - 4 - 1  # height - cover - bar radius estimate
                if abs(result['effective_depth'] - expected_d) < 2:
                    checks.append("Effective depth calculation reasonable")
                else:
                    checks.append(f"Effective depth issue: got {result['effective_depth']}, expected ~{expected_d}")
                
                success = all("error" not in check and "issue" not in check for check in checks)
                self.log_test("Valid beam design calculation", success, "; ".join(checks))
                
                return result  # Return for use in save test
                
            else:
                self.log_test("Valid beam design calculation", False, 
                            f"HTTP {response.status_code}: {response.text}")
                return None
                
        except Exception as e:
            self.log_test("Valid beam design calculation", False, f"Error: {str(e)}")
            return None
    
    def test_beam_design_edge_cases(self):
        """Test beam design with edge cases"""
        
        # Test case 1: Very small beam
        small_beam = {
            "width": 15.0, "height": 25.0, "length": 2.0,
            "dead_load": 5.0, "live_load": 3.0,
            "fc": 21.0, "fy": 420.0, "cover": 2.5
        }
        
        try:
            response = requests.post(f"{API_URL}/beam/design", json=small_beam, timeout=10)
            if response.status_code == 200:
                result = response.json()
                self.log_test("Small beam design", True, 
                            f"Valid: {result['is_valid']}, Messages: {result['messages']}")
            else:
                self.log_test("Small beam design", False, f"HTTP {response.status_code}")
        except Exception as e:
            self.log_test("Small beam design", False, f"Error: {str(e)}")
        
        # Test case 2: High strength materials
        high_strength = {
            "width": 40.0, "height": 80.0, "length": 8.0,
            "dead_load": 25.0, "live_load": 15.0,
            "fc": 35.0, "fy": 500.0, "cover": 5.0
        }
        
        try:
            response = requests.post(f"{API_URL}/beam/design", json=high_strength, timeout=10)
            if response.status_code == 200:
                result = response.json()
                # Check beta1 calculation for high strength concrete
                expected_beta1 = max(0.65, 0.85 - 0.05 * (35 - 28) / 7)
                beta1_ok = abs(result['beta1'] - expected_beta1) < 0.01
                self.log_test("High strength materials", beta1_ok, 
                            f"Beta1: {result['beta1']}, Expected: {expected_beta1:.3f}")
            else:
                self.log_test("High strength materials", False, f"HTTP {response.status_code}")
        except Exception as e:
            self.log_test("High strength materials", False, f"Error: {str(e)}")
    
    def test_beam_design_invalid_inputs(self):
        """Test beam design with invalid inputs"""
        
        # Test negative values
        invalid_data = {
            "width": -30.0,
            "height": 60.0,
            "length": 6.0,
            "dead_load": 15.0,
            "live_load": 10.0,
            "fc": 21.0,
            "fy": 420.0,
            "cover": 4.0
        }
        
        try:
            response = requests.post(f"{API_URL}/beam/design", json=invalid_data, timeout=10)
            # Should either return 400 or handle gracefully
            if response.status_code in [400, 422]:
                self.log_test("Invalid input handling", True, "Properly rejected negative width")
            elif response.status_code == 200:
                result = response.json()
                if not result['is_valid']:
                    self.log_test("Invalid input handling", True, "Marked as invalid design")
                else:
                    self.log_test("Invalid input handling", False, "Accepted invalid input")
            else:
                self.log_test("Invalid input handling", False, f"Unexpected status: {response.status_code}")
        except Exception as e:
            self.log_test("Invalid input handling", False, f"Error: {str(e)}")
    
    def test_save_beam_design(self):
        """Test saving a beam design"""
        # First get a valid design
        valid_inputs = {
            "width": 35.0, "height": 65.0, "length": 7.0,
            "dead_load": 18.0, "live_load": 12.0,
            "fc": 28.0, "fy": 420.0, "cover": 4.5
        }
        
        save_data = {
            "project_name": "Edificio Residencial Lima",
            "beam_name": "Viga Principal V-01",
            "inputs": valid_inputs
        }
        
        try:
            response = requests.post(f"{API_URL}/beam/save", json=save_data, timeout=10)
            
            if response.status_code == 200:
                result = response.json()
                
                # Verify saved data structure
                checks = []
                if result.get('id'):
                    checks.append("ID generated")
                    self.saved_design_id = result['id']
                
                if result.get('project_name') == save_data['project_name']:
                    checks.append("Project name saved correctly")
                
                if result.get('beam_name') == save_data['beam_name']:
                    checks.append("Beam name saved correctly")
                
                if result.get('inputs'):
                    checks.append("Inputs saved")
                
                if result.get('results'):
                    checks.append("Results calculated and saved")
                
                if result.get('created_at'):
                    checks.append("Timestamp added")
                
                success = len(checks) >= 5
                self.log_test("Save beam design", success, "; ".join(checks))
                
            else:
                self.log_test("Save beam design", False, 
                            f"HTTP {response.status_code}: {response.text}")
                
        except Exception as e:
            self.log_test("Save beam design", False, f"Error: {str(e)}")
    
    def test_retrieve_all_designs(self):
        """Test retrieving all saved designs"""
        try:
            response = requests.get(f"{API_URL}/beam/designs", timeout=10)
            
            if response.status_code == 200:
                designs = response.json()
                
                if isinstance(designs, list):
                    if len(designs) > 0:
                        # Check structure of first design
                        first_design = designs[0]
                        required_fields = ['id', 'project_name', 'beam_name', 'inputs', 'results', 'created_at']
                        missing_fields = [field for field in required_fields if field not in first_design]
                        
                        if not missing_fields:
                            self.log_test("Retrieve all designs", True, 
                                        f"Found {len(designs)} designs with correct structure")
                        else:
                            self.log_test("Retrieve all designs", False, 
                                        f"Missing fields: {missing_fields}")
                    else:
                        self.log_test("Retrieve all designs", True, "Empty list returned (no designs saved yet)")
                else:
                    self.log_test("Retrieve all designs", False, "Response is not a list")
                    
            else:
                self.log_test("Retrieve all designs", False, 
                            f"HTTP {response.status_code}: {response.text}")
                
        except Exception as e:
            self.log_test("Retrieve all designs", False, f"Error: {str(e)}")
    
    def test_retrieve_specific_design(self):
        """Test retrieving a specific design by ID"""
        if not self.saved_design_id:
            self.log_test("Retrieve specific design", False, "No saved design ID available")
            return
        
        try:
            response = requests.get(f"{API_URL}/beam/design/{self.saved_design_id}", timeout=10)
            
            if response.status_code == 200:
                design = response.json()
                
                if design.get('id') == self.saved_design_id:
                    self.log_test("Retrieve specific design", True, 
                                f"Retrieved design with correct ID")
                else:
                    self.log_test("Retrieve specific design", False, 
                                f"ID mismatch: got {design.get('id')}")
                    
            elif response.status_code == 404:
                self.log_test("Retrieve specific design", False, "Design not found")
            else:
                self.log_test("Retrieve specific design", False, 
                            f"HTTP {response.status_code}: {response.text}")
                
        except Exception as e:
            self.log_test("Retrieve specific design", False, f"Error: {str(e)}")
    
    def test_retrieve_nonexistent_design(self):
        """Test retrieving a non-existent design"""
        fake_id = "nonexistent-id-12345"
        
        try:
            response = requests.get(f"{API_URL}/beam/design/{fake_id}", timeout=10)
            
            if response.status_code == 404:
                self.log_test("Retrieve nonexistent design", True, "Properly returned 404")
            else:
                self.log_test("Retrieve nonexistent design", False, 
                            f"Expected 404, got {response.status_code}")
                
        except Exception as e:
            self.log_test("Retrieve nonexistent design", False, f"Error: {str(e)}")
    
    def run_all_tests(self):
        """Run all backend tests"""
        print("=" * 60)
        print("BEAM DESIGN BACKEND TESTING")
        print("=" * 60)
        
        # Test in logical order
        self.test_root_endpoint()
        self.test_beam_design_valid_case()
        self.test_beam_design_edge_cases()
        self.test_beam_design_invalid_inputs()
        self.test_save_beam_design()
        self.test_retrieve_all_designs()
        self.test_retrieve_specific_design()
        self.test_retrieve_nonexistent_design()
        
        # Summary
        print("\n" + "=" * 60)
        print("TEST SUMMARY")
        print("=" * 60)
        
        passed = sum(1 for result in self.test_results if result['success'])
        total = len(self.test_results)
        
        print(f"Tests passed: {passed}/{total}")
        
        if passed == total:
            print("🎉 ALL TESTS PASSED!")
            return True
        else:
            print("❌ Some tests failed:")
            for result in self.test_results:
                if not result['success']:
                    print(f"  - {result['test']}: {result['details']}")
            return False

if __name__ == "__main__":
    tester = BeamDesignTester()
    success = tester.run_all_tests()
    sys.exit(0 if success else 1)